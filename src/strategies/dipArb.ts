import { Strategy } from "./types.js";
import { ClobClient, Side, AssetType } from "@polymarket/clob-client";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { GammaClient } from "../clients/gamma-api.js";
import { PriceSocket, PriceUpdate } from "../clients/websocket.js";
import { PnlManager, CoinPnL } from "../lib/pnlManager.js";
import { WalletGuard } from "../lib/walletGuard.js";
import { redeemPositions } from "../scripts/redeem.js";
import { CONFIG } from "../clients/config.js";
import { ethers } from "ethers";

// --- UI / ANSI Helpers ---
const COLORS = {
    RESET: "\x1b[0m",
    BRIGHT: "\x1b[1m",
    DIM: "\x1b[2m",
    RED: "\x1b[31m",
    GREEN: "\x1b[32m",
    YELLOW: "\x1b[33m",
    BLUE: "\x1b[34m",
    MAGENTA: "\x1b[35m",
    CYAN: "\x1b[36m",
    WHITE: "\x1b[37m",
    BG_RED: "\x1b[41m",
    BG_GREEN: "\x1b[42m",
};

function color(text: string, colorCode: string): string {
    return `${colorCode}${text}${COLORS.RESET}`;
}

function box(lines: string[], colorCode: string = COLORS.CYAN): void {
    const width = Math.max(...lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, '').length)) + 4;
    const top = `╔${"═".repeat(width - 2)}╗`;
    const bot = `╚${"═".repeat(width - 2)}╝`;

    console.log(colorCode + top + COLORS.RESET);
    lines.forEach(l => {
        const visibleLen = l.replace(/\x1b\[[0-9;]*m/g, '').length;
        const padding = " ".repeat(width - 4 - visibleLen);
        console.log(`${colorCode}║ ${COLORS.RESET} ${l}${padding} ${colorCode}║${COLORS.RESET}`);
    });
    console.log(colorCode + bot + COLORS.RESET);
}

// --- Interfaces ---

interface PricePoint {
    price: number;
    timestamp: number;
}

interface SideState {
    totalShares: number;
    totalCost: number; // Sum of (price * shares)
    avgPrice: number;  // totalCost / totalShares
    // Stats for display
    buysTriggered: number;
    lastBuyPrice?: number; // For debounce

    // [FIX 1 & 2] Execution Locks
    isBuying: boolean;
    lastBuyTs: number;

    // [FIX Leg 2 Timeout] Track when we started this position
    firstBuyTs: number;
}

interface MarketState {
    marketId: string;
    tokenIds: string[]; // [YesToken, NoToken]
    prices: Map<string, PricePoint[]>; // History for each token
    position: {
        yes: SideState; // tokenIds[0]
        no: SideState;  // tokenIds[1]
    };
    // Helper to map tokenId to 'yes' or 'no'
    tokenIdToSide: Map<string, 'yes' | 'no'>;

    status: 'scanning' | 'complete' | 'EXITING' | 'partial_unwind';
    endTime: number;
    startTime: number;
    slug: string;
    question: string;



    // Convergence / Stagnation Tracking
    bestPairCost: number;       // Lowest pair cost seen so far
    lastImproveTs: number;      // Last time pair cost improved

    // [SAFETY] Hard Cap per Market (15% of Wallet)
    maxMarketUsd: number;

    // Global stats
    stats: {
        signalsDetected: number;
    };

    // [FIX 2] Arb Locked Flag
    arbLocked?: boolean;
}

export interface LateExitConfig {
    enabled: boolean;
    timeRemainingSeconds: number; // e.g. 60
    minWinnerPrice: number;       // e.g. 0.70
    minProfitUsd: number;         // e.g. 0.00 (just be positive)
}

export interface PartialUnwindConfig {
    enabled: boolean;
    timeRemainingSeconds: number; // e.g. 45
    minWinnerPrice: number;       // e.g. 0.70
    minProfitUsd: number;         // e.g. 0.20
}

export interface EarlyExitConfig {
    enabled: boolean;
    minProfitPct: number;   // e.g. 0.15 = +15%
    minProfitUsd: number;   // e.g. $1
    maxSlippagePct: number; // e.g. 0.03
}

export interface DipArbConfig {
    coin: string;
    dipThreshold: number;      // movePct
    slidingWindowMs: number;
    sumTarget: number;
    shares: number;
    leg2TimeoutSeconds: number;
    ignorePriceBelow?: number;
    verbose?: boolean;
    info?: boolean;
    redeem?: boolean;
    dashboard?: boolean;
    strategy?: string;
    earlyExit?: EarlyExitConfig;
    lateExit?: LateExitConfig;
    partialUnwind?: PartialUnwindConfig;
    // windowMinutes removed
}

export class DipArbStrategy implements Strategy {
    name = "DipArbitrage (Gabagool)";
    private clobClient?: ClobClient;
    private gammaClient: GammaClient;
    private priceSocket: PriceSocket;
    private pnlManager: PnlManager;

    private config: DipArbConfig;
    private activeMarkets: Map<string, MarketState> = new Map();
    private statusInterval?: NodeJS.Timeout;

    constructor(config: Partial<DipArbConfig> = {}) {
        this.config = {
            coin: config.coin || "ETH",
            dipThreshold: config.dipThreshold || 0.15,
            slidingWindowMs: config.slidingWindowMs || 3000,
            sumTarget: config.sumTarget || 0.95,
            shares: config.shares || 10,
            leg2TimeoutSeconds: config.leg2TimeoutSeconds || 60,
            ignorePriceBelow: config.ignorePriceBelow || 0,
            verbose: config.verbose || false,
            info: config.info || false,
            redeem: config.redeem || false,
            dashboard: config.dashboard || false,
            earlyExit: config.earlyExit || {
                enabled: true,
                minProfitPct: 0.10, // 10%
                minProfitUsd: 0.50, // 50c
                maxSlippagePct: 0.03
            },
            lateExit: config.lateExit || {
                enabled: true,
                timeRemainingSeconds: 60,
                minWinnerPrice: 0.70,
                minProfitUsd: 0.01 // Minimal profit required, just don't exit for loss
            },
            partialUnwind: config.partialUnwind || {
                enabled: true,
                timeRemainingSeconds: 45,
                minWinnerPrice: 0.70,
                minProfitUsd: 0.20
            }
        } as DipArbConfig;

        this.gammaClient = new GammaClient();
        this.priceSocket = new PriceSocket(this.onPriceUpdate.bind(this));
        this.pnlManager = new PnlManager();
    }

    async init(clobClient: ClobClient, relayClient: RelayClient): Promise<void> {
        this.clobClient = clobClient;

        // AUTO-APPROVE ALLOWANCE
        try {
            const res = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });

            // Parse allowances map (max of all spenders)
            const allowances = (res as any).allowances ? Object.values((res as any).allowances).map((a: any) => parseFloat(a)) : [];
            const allowance = allowances.length > 0 ? Math.max(...allowances) : 0;

            const bal = parseFloat((res as any).balance || "0") / 1e6;
            this.pnlManager.updateWalletBalance(bal); // INIT DASHBOARD BALANCE

            if (allowance < 1000 * 1e6) { // Less than $1000 approved
                console.log(color("⚠️ Insufficient Allowance. Approving USDC.e...", COLORS.YELLOW));
                const tx = await this.clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                console.log(color("✅ Allowance Approved!", COLORS.GREEN));
            } else {
                console.log(color(`✅ Allowance OK: $${(allowance / 1e6).toFixed(2)}`, COLORS.GREEN));
            }
        } catch (e: any) {
            console.error(color(`Failed to check/update allowance: ${e.message}`, COLORS.RED));
        }

        this.logHeader();
    }

    /**
     * Finds the next suitable market and starts monitoring it.
     */
    private async rotateToNextMarket(): Promise<void> {
        // [FIX 1] Enforce One Active Market Per Coin (Stop Stacking)
        for (const c of Object.values(this.pnlManager.getAllStats().activeCycles)) {
            if (c.coin === this.config.coin && c.status === 'OPEN') {

                // [RESUME] If we have an open cycle in DB but NOT in memory (Restart Recov), resume it.
                if (this.activeMarkets.size === 0) {
                    console.log(color(`🔄 Detected orphaned open cycle ${c.id}. Resuming...`, COLORS.MAGENTA));

                    try {
                        // 1. Try scanning upcoming (fast, standard)
                        let markets = await this.scanUpcomingMarkets(this.config.coin, '15m');
                        let targetMarket = markets.find(m => m.slug === c.id || m.questionID === c.id);

                        // 2. If not found, try DIRECT fetch (handles active-but-started or slightly expired)
                        if (!targetMarket) {
                            console.log(color(`   Secondary search for ${c.id}...`, COLORS.DIM));
                            // GammaClient.getMarkets supports query params
                            const direct = await this.gammaClient.getMarkets(`slug=${c.id}`);
                            if (direct && direct.length > 0) {
                                targetMarket = direct[0];
                            }
                        }

                        if (targetMarket) {
                            console.log(color(`✅ Found market data for ${c.id}. Re-attaching...`, COLORS.GREEN));

                            // [FIX RESUMPTION PARSING]
                            let tokenIds: string[] = [];
                            try {
                                // Gamma API 'getMarkets' usually returns 'clobTokenIds'
                                if (targetMarket.clobTokenIds) {
                                    if (typeof targetMarket.clobTokenIds === 'string') {
                                        tokenIds = JSON.parse(targetMarket.clobTokenIds);
                                    } else if (Array.isArray(targetMarket.clobTokenIds)) {
                                        tokenIds = targetMarket.clobTokenIds;
                                    }
                                } else if (targetMarket.tokens) {
                                    // Fallback for some API versions
                                    const yesToken = targetMarket.tokens.find((t: any) => t.outcome === 'Yes');
                                    const noToken = targetMarket.tokens.find((t: any) => t.outcome === 'No');
                                    if (yesToken && noToken) {
                                        tokenIds = [yesToken.token_id, noToken.token_id];
                                    }
                                }
                            } catch (e) {
                                console.error(color("❌ Failed to parse token IDs", COLORS.RED));
                            }

                            if (tokenIds.length < 2) {
                                console.log(color("❌ Cannot parse tokens for resumption.", COLORS.RED));
                            } else {
                                const startTime = new Date(targetMarket.startTime || targetMarket.startDateIso).getTime();
                                const endTime = new Date(targetMarket.endTime || targetMarket.endDateIso).getTime();

                                const tokenIdToSide = new Map<string, 'yes' | 'no'>();
                                tokenIdToSide.set(tokenIds[0], 'yes');
                                tokenIdToSide.set(tokenIds[1], 'no');

                                this.activeMarkets.set(targetMarket.id, {
                                    marketId: targetMarket.id,
                                    tokenIds: tokenIds,
                                    prices: new Map(),
                                    tokenIdToSide: tokenIdToSide,
                                    position: {
                                        yes: { totalShares: 0, totalCost: c.yesCost || 0, avgPrice: 0, buysTriggered: 0, isBuying: false, lastBuyTs: 0, firstBuyTs: 0 },
                                        no: { totalShares: 0, totalCost: c.noCost || 0, avgPrice: 0, buysTriggered: 0, isBuying: false, lastBuyTs: 0, firstBuyTs: 0 }
                                    },
                                    status: 'scanning',
                                    endTime: endTime,
                                    startTime: startTime,
                                    slug: targetMarket.slug,
                                    question: targetMarket.question,
                                    bestPairCost: Infinity,
                                    lastImproveTs: Date.now(),
                                    maxMarketUsd: 10,
                                    stats: { signalsDetected: 0 }
                                });

                                this.priceSocket.connect(tokenIds);
                                this.startStatusLoop();
                                return;
                            }
                        } else {
                            console.log(color(`⚠️ Could not find market ${c.id} from API (Expired?).`, COLORS.YELLOW));

                            // [FIX LOOP] If we have NO exposure, just kill it.
                            if ((c.yesCost || 0) === 0 && (c.noCost || 0) === 0) {
                                console.log(color("🧹 Orphan cycle has NO position. Auto-closing to unblock.", COLORS.BRIGHT + COLORS.MAGENTA));
                                this.pnlManager.closeCycle(c.id, 'ABANDON', 0);
                                // Retry immediately to find new market
                                this.rotateToNextMarket();
                                return;
                            } else {
                                console.log(color("❌ Money potentially stuck in unknown market. User intervention required.", COLORS.BG_RED + COLORS.WHITE));
                            }
                        }
                    } catch (e) {
                        console.error(color(`Failed to resume cycle: ${e}`, COLORS.RED));
                    }
                }

                console.log(color(`⏸ Existing cycle still open for ${this.config.coin}. Not rotating.`, COLORS.YELLOW));
                setTimeout(() => this.rotateToNextMarket(), 30000);
                return;
            }
        }

        // 1. Cleanup old market
        if (this.activeMarkets.size > 0) {
            // Check if we need to close stats as LOSS/ABANDON
            for (const state of this.activeMarkets.values()) {
                if (state.status === 'scanning' && (state.position.yes.totalShares > 0 || state.position.no.totalShares > 0)) {
                    // [FIX 2] Force Close Before Abandon
                    await this.forceCloseMarket(state);

                    const lossAmount = state.position.yes.totalCost + state.position.no.totalCost;
                    this.pnlManager.closeCycle(state.marketId, 'ABANDON', -lossAmount);
                }
            }

            console.log(color("\n🔄 Rotating to next market...", COLORS.CYAN));
            this.priceSocket.close(); // Unsubscribe all
            this.activeMarkets.clear();
            if (this.statusInterval) clearInterval(this.statusInterval);
            // No need to reset reservedUsd, WalletGuard manages it globally
        }

        // 2. Scan loop
        // [FIX WalletGuard Leak] Reset reservation since we are about to fetch fresh balance
        // THIS IS THE ONLY SAFE PLACE TO RESET (Clean slate)
        WalletGuard.reset();

        let markets: any[] = [];
        let attempts = 0;

        console.log(`[${this.name}] Scanning for ${this.config.coin} 15m markets...`);

        while (markets.length === 0) {
            markets = await this.scanUpcomingMarkets(this.config.coin, '15m');
            markets = markets.filter(m => {
                const endTime = new Date(m.events?.[0]?.endDate || m.endDateIso).getTime();
                return endTime > Date.now();
            });

            if (markets.length === 0) {
                attempts++;
                if (attempts % 6 === 0) console.log(color("Waiting for new markets...", COLORS.DIM));
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        // 3. Select best
        const targetMarket = markets[0];

        // Parse token IDs
        let tokenIds: string[] = [];
        try {
            if (typeof targetMarket.clobTokenIds === 'string') {
                tokenIds = JSON.parse(targetMarket.clobTokenIds);
            } else if (Array.isArray(targetMarket.clobTokenIds)) {
                tokenIds = targetMarket.clobTokenIds;
            }
        } catch (e) {
            console.error(color("Failed to parse clobTokenIds", COLORS.RED));
            return this.rotateToNextMarket();
        }

        // Times
        const endTimeStr = targetMarket.events?.[0]?.endDate || targetMarket.endDateIso;
        const endTime = new Date(endTimeStr).getTime();

        const slugParts = targetMarket.slug.split('-');
        let startTime = endTime - 15 * 60 * 1000;
        const timestampInSlug = parseInt(slugParts[slugParts.length - 1]);
        if (!isNaN(timestampInSlug)) {
            startTime = timestampInSlug * 1000;
        }

        const timeUntilStart = startTime - Date.now();

        // [SAFETY REFINED] Determine Max Market Cap (15% of Wallet)
        // Ensure fresh balance or abort.
        let walletBal = 0;

        try {
            if (this.clobClient) {
                const res = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                walletBal = parseFloat((res as any).balance || "0") / 1e6;
                this.pnlManager.updateWalletBalance(walletBal);
            }
        } catch (e) {
            console.error(color("FATAL: Failed to fetch wallet balance for Market Cap.", COLORS.RED));
        }

        if (walletBal <= 0) {
            // Try fallback to PnlManager stats IF available?
            walletBal = this.pnlManager.getAllStats().walletBalance;
        }

        if (walletBal <= 0) {
            console.error(color("❌ Cannot determine wallet balance. Aborting market entry for safety.", COLORS.RED));
            // Wait and retry
            setTimeout(() => this.rotateToNextMarket(), 10000);
            return;
        }

        const riskPct = walletBal < 20 ? 0.50 : 0.15;
        const maxMarketUsd = walletBal * riskPct;

        // Log Selection
        box([
            `Selected: ${color(targetMarket.slug, COLORS.BRIGHT)}`,
            `Question: ${targetMarket.question}`,
            `Start:    ${new Date(startTime).toLocaleTimeString()} (${timeUntilStart > 0 ? "in " + (timeUntilStart / 60000).toFixed(1) + "m" : "Active"})`,
            `End:      ${new Date(endTime).toLocaleTimeString()}`,
            `Info:     ${color(`Max Exposure: $${maxMarketUsd.toFixed(2)} (${(riskPct * 100).toFixed(0)}%)`, COLORS.MAGENTA)}`,
            `Status:   ${color("WATCHING (Weighted Avg Logic)", COLORS.GREEN)}`
        ], COLORS.CYAN);

        if (tokenIds.length === 2) {
            const tokenIdToSide = new Map<string, 'yes' | 'no'>();
            tokenIdToSide.set(tokenIds[0], 'yes');
            tokenIdToSide.set(tokenIds[1], 'no');

            this.activeMarkets.set(targetMarket.id, {
                marketId: targetMarket.id,
                tokenIds: tokenIds,
                prices: new Map(),
                tokenIdToSide: tokenIdToSide,
                position: {
                    yes: { totalShares: 0, totalCost: 0, avgPrice: 0, buysTriggered: 0, isBuying: false, lastBuyTs: 0, firstBuyTs: 0 },
                    no: { totalShares: 0, totalCost: 0, avgPrice: 0, buysTriggered: 0, isBuying: false, lastBuyTs: 0, firstBuyTs: 0 }
                },
                status: 'scanning',
                endTime: endTime,
                startTime: startTime,
                slug: targetMarket.slug,
                question: targetMarket.question,
                bestPairCost: Infinity,
                lastImproveTs: Date.now(),
                maxMarketUsd: maxMarketUsd, // [SAFETY]
                stats: { signalsDetected: 0 }
            });

            this.priceSocket.connect(tokenIds);
            this.startStatusLoop();

        } else {
            console.error(color("Invalid market token count.", COLORS.RED));
            setTimeout(() => this.rotateToNextMarket(), 5000);
        }
    }

    private startStatusLoop() {
        if (this.statusInterval) clearInterval(this.statusInterval);
        this.statusInterval = setInterval(() => this.checkStatusAndRotate(), 5000); // 5s update
    }

    private async checkStatusAndRotate() {
        // --- SIMPLE COMPACT LOG (Replaces Dashboard) ---
        let activeCount = 0;
        for (const state of this.activeMarkets.values()) {
            const now = Date.now();
            const timeLeft = Math.round((state.endTime - now) / 1000);

            // [SAFETY] Race Condition Guard
            // [FIX 3] RELAX GUARD to allow exits to process even if status is 'EXITING' or 'partial_unwind'
            // We ONLY skip if status is 'complete' (meaning totally dead/waiting)
            // [SAFETY] Race Condition Guard
            // [FIX 3] RELAX GUARD to allow exits to process even if status is 'EXITING' or 'partial_unwind'
            // We ONLY skip if status is 'complete' (meaning totally dead/waiting)
            if (state.status === 'complete') continue;

            // [FIX 2] Arb Locked Guard
            // If arb is locked, we keep scanning but skip logic unless close to expiry (allow late exits)
            if (state.arbLocked && timeLeft > 90) continue;

            // [SAFETY] Daily Drawdown Kill Switch (Dynamic)
            // Small wallets (<$20) are volatile, allow 30% drawdown.
            // Standard wallets, keep tight 5% leash.


            // Better: Read PnL manager state.
            const stats = this.pnlManager.getAllStats();
            const startBal = stats.startingBalance;

            // [TIERED DRAWDOWN]
            // < $50  -> 50%
            // < $100 -> 25%
            // > $100 -> 10%
            let ddLimit = 0.10;
            if (startBal < 50) ddLimit = 0.50;
            else if (startBal < 100) ddLimit = 0.25;

            if (this.pnlManager.checkDrawdown(ddLimit)) {
                console.error(color(`\n💀 FATAL: DAILY DRAWDOWN LIMIT EXCEEDED (${(ddLimit * 100).toFixed(0)}%). SHUTTING DOWN.`, COLORS.BG_RED + COLORS.WHITE));
                process.exit(1);
            }

            // [SAFETY] LEG-1 ABORT: Force Hedge if Timeout
            // Detect Naked Position
            const isNakedYes = (state.position.yes.totalShares > 0 && state.position.no.totalShares === 0);
            const isNakedNo = (state.position.no.totalShares > 0 && state.position.yes.totalShares === 0);

            // 2. Force Hedge Naked Positions
            // Guard already ensured status === 'scanning', so this is safe.

            if (isNakedYes || isNakedNo) {
                const nakedSide = isNakedYes ? 'yes' : 'no';
                const sideState = state.position[nakedSide];
                const age = now - sideState.firstBuyTs;

                if (age > this.config.leg2TimeoutSeconds * 1000) {
                    // FORCE HEDGE LOGIC
                    console.log(color(`⚠️ TIMEOUT: Leg-2 missing for ${nakedSide.toUpperCase()} (${(age / 1000).toFixed(1)}s). Forcing Hedge...`, COLORS.YELLOW));

                    const oppositeSide = isNakedYes ? 'no' : 'yes';
                    const oppositeTokenId = state.tokenIds[isNakedYes ? 1 : 0]; // 0=Yes, 1=No

                    // Get Market Price for opposite side
                    const oppPriceStr = this.getLastPrice(state, isNakedYes ? 1 : 0);
                    const oppPrice = parseFloat(oppPriceStr);

                    if (!isNaN(oppPrice) && oppPrice > 0) {
                        // Match shares to neutralize delta
                        const sharesToHedge = Math.min(sideState.totalShares, this.config.shares * 3); // Cap size slightly for safety

                        const filledShares = await this.executeOrder(
                            oppositeTokenId,
                            sharesToHedge,
                            oppPrice, // Market Order effectively (using last price)
                            "FORCED-HEDGE",
                            true // [FIX] Bypass Risk Limit for emergency hedge
                        );

                        if (filledShares > 0) {
                            // [FIX STATE] Manually update local state since executeOrder doesn't do it for us here
                            const oppSideState = state.position[oppositeSide];
                            oppSideState.totalShares += filledShares;
                            oppSideState.totalCost += filledShares * oppPrice;
                            oppSideState.avgPrice = oppSideState.totalCost / oppSideState.totalShares;

                            // [CRITICAL] POST-HEDGE LOCK
                            // [FIX] Don't kill the cycle. Set locked flag but keep scanning for exits.
                            state.arbLocked = true;
                            state.status = 'scanning';

                            console.log(color(`🔒 PAIR FLATTENED (Forced Hedge: ${filledShares} ${oppositeSide.toUpperCase()}). Locked new buys, scanning for exits...`, COLORS.MAGENTA));
                        } else {
                            console.log(color("❌ Forced Hedge Failed: executeOrder returned 0.", COLORS.RED));
                        }

                    } else {
                        console.log(color("❌ Could not force hedge: Price unavailable.", COLORS.RED));
                    }
                }
            }

            // [FIX 4] EXIT HIERARCHY (Time Priority)
            // 1. Partial Unwind (< 45s) - Highest Priority (Snapshot risk reduction)
            await this.checkAndExecutePartialUnwind(state);

            // 2. Late Exit (< 60s)
            await this.checkAndExecuteLateExit(state);

            // 3. Early Exit (Profit Locking) - Lowest Priority
            await this.checkAndExecuteEarlyExit(state);

            // AUTOMATIC ROTATION TRIGGER (Market End)
            if (timeLeft <= 0) {
                console.log(color(`[STATUS] Market ${state.slug} has ENDED.`, COLORS.YELLOW));

                // [FIX 4] Auto-Redeem on Expiry
                try {
                    await redeemPositions();
                } catch (e) {
                    console.error("Auto-redeem failed:", e);
                }

                // [SAFETY] Pessimistic Loss
                if (state.position.yes.totalShares > 0 || state.position.no.totalShares > 0) {
                    const lossAmount = state.position.yes.totalCost + state.position.no.totalCost;
                    this.pnlManager.closeCycle(state.marketId, 'LOSS', -lossAmount);
                } else {
                    // [FIX LOOP] Clean Exit (Watching only, no shares)
                    // Must close cycle to remove from 'activeCycles' in PnL
                    this.pnlManager.closeCycle(state.marketId, 'EXPIRED', 0);
                    console.log(color("🧹 Cycle expired while watching. Closed cleanly.", COLORS.DIM));
                }

                this.rotateToNextMarket();
                return; // Exit loop, rotation handles reset
            }
            activeCount++;

            const timeStr = `${Math.floor(timeLeft / 60)}m ${timeLeft % 60}s`;
            const p1 = this.getLastPrice(state, 0);
            const p2 = this.getLastPrice(state, 1);

            // Position Stats
            const yesAvg = state.position.yes.totalShares > 0 ? state.position.yes.avgPrice.toFixed(3) : "0.000";
            const noAvg = state.position.no.totalShares > 0 ? state.position.no.avgPrice.toFixed(3) : "0.000";

            let pairCostStr = "N/A";
            if (state.position.yes.totalShares > 0 && state.position.no.totalShares > 0) {
                pairCostStr = (state.position.yes.avgPrice + state.position.no.avgPrice).toFixed(3);
            }

            const totalSpent = state.position.yes.totalCost + state.position.no.totalCost;
            const posStr = `Pos: [Yes:${yesAvg} (${state.position.yes.totalShares})] [No:${noAvg} (${state.position.no.totalShares})] Cost:${pairCostStr} Exp:$${totalSpent.toFixed(2)}`;

            // Compact Log
            console.log(
                `${color("[STATUS]", COLORS.CYAN)} ` +
                `Time: ${timeStr.padEnd(9)} | ` +
                `Px: ${color(p1, COLORS.GREEN)}/${color(p2, COLORS.RED)} | ` +
                `${posStr}`
            );
        }

        if (activeCount === 0) {
            this.rotateToNextMarket();
        }
    }

    private getLastPrice(state: MarketState, index: number): string {
        const arr = state.prices.get(state.tokenIds[index]);
        if (!arr || arr.length === 0) return "?.???";
        return arr[arr.length - 1].price.toFixed(3);
    }

    private async scanUpcomingMarkets(coin: string, duration: '5m' | '15m'): Promise<any[]> {
        const durationIntervals: Record<string, number> = { '5m': 300, '15m': 900 };
        const intervalSeconds = durationIntervals[duration];

        // Scan wider window to catch Next Market (up to 2h ahead)
        const minEndSeconds = Math.floor(Date.now() / 1000);
        const maxEndSeconds = minEndSeconds + 2 * 60 * 60;

        const minSlotStart = Math.floor((minEndSeconds - intervalSeconds) / intervalSeconds) * intervalSeconds;
        const maxSlotStart = Math.ceil(maxEndSeconds / intervalSeconds) * intervalSeconds;

        const slugsToFetch: string[] = [];
        const coinLower = coin.toLowerCase();
        for (let slotStart = minSlotStart; slotStart <= maxSlotStart; slotStart += intervalSeconds) {
            slugsToFetch.push(`${coinLower}-updown-${duration}-${slotStart}`);
        }

        console.log(`[Scanning] Checking ${slugsToFetch.length} potential slots...`);

        const foundMarkets: any[] = [];
        for (const slug of slugsToFetch) {
            try {
                const results = await this.gammaClient.getMarkets(`slug=${slug}`);
                if (results && results.length > 0) {
                    const m = results[0];
                    if (m.active && !m.closed) foundMarkets.push(m);
                }
            } catch (e) { }
        }
        foundMarkets.sort((a, b) => new Date(a.end_date_iso).getTime() - new Date(b.end_date_iso).getTime());
        return foundMarkets;
    }

    async run(): Promise<void> {
        if (this.config.redeem) {
            console.log(color("\n[REDEEM MODE] Starting redemption process...", COLORS.MAGENTA));
            try {
                await redeemPositions();
                console.log(color("\n✅ Redemption process completed.", COLORS.GREEN));
            } catch (e: any) {
                console.error(color(`❌ Redemption failed: ${e.message}`, COLORS.RED));
            }
            process.exit(0);
        }

        if (this.config.info) {
            console.log(color("\n[INFO MODE] Account Details:", COLORS.BRIGHT + COLORS.CYAN));

            if (this.clobClient) {
                try {
                    const eoaAddr = await this.clobClient!.signer!.getAddress();
                    console.log(`EOA Address:    ${eoaAddr}`);

                    if (CONFIG.POLY_PROXY_ADDRESS) {
                        console.log(`Proxy Address:  ${CONFIG.POLY_PROXY_ADDRESS}`);
                    } else {
                        console.log(`Proxy Address:  (None - Using EOA)`);
                    }

                    // Fetch USDC Balance (Proxy if used, else EOA)
                    const res = await this.clobClient!.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                    const bal = parseFloat((res as any).balance || "0") / 1e6;
                    console.log(`USDC.e Balance: $${bal.toFixed(2)}`);

                    // Fetch POL (MATIC) Balance for EOA (Gas)
                    // Provider attached to signer
                    const provider = (this.clobClient!.signer as any).provider;
                    if (provider) {
                        const polBal = await provider.getBalance(eoaAddr);
                        console.log(`POL (Gas):      ${parseFloat(ethers.utils.formatEther(polBal)).toFixed(4)} POL`);
                    }
                } catch (e: any) {
                    console.error(color(`Error fetching info: ${e.message}`, COLORS.RED));
                }
            } else {
                console.log(color("ClobClient not initialized.", COLORS.RED));
            }
            process.exit(0);
        }

        await this.rotateToNextMarket();
    }
    async cleanup(): Promise<void> {
        this.priceSocket.close();
        if (this.statusInterval) clearInterval(this.statusInterval);
    }

    private onPriceUpdate(update: PriceUpdate) {
        const tokenId = update.asset_id;
        const currentPrice = parseFloat(update.price);
        const now = Date.now();

        // Find market
        let marketState: MarketState | undefined;
        for (const state of this.activeMarkets.values()) {
            if (state.tokenIds.includes(tokenId)) {
                marketState = state;
                break;
            }
        }
        if (!marketState) return;

        // Skip if market is already complete
        if (marketState.status === 'complete') return;

        // Update History
        if (!marketState.prices.has(tokenId)) marketState.prices.set(tokenId, []);
        const history = marketState.prices.get(tokenId)!;
        history.push({ price: currentPrice, timestamp: now });

        // Prune older than 3s (slidingWindowMs)
        const cutoff = now - this.config.slidingWindowMs;
        while (history.length > 0 && history[0].timestamp < cutoff) history.shift();

        // Logic Loop

        // 1. ENTRY LOGIC (Scanning)
        if (marketState.status === 'scanning') {
            this.checkOpportunity(marketState, tokenId, currentPrice, history);
        }

        // 2. EXIT LOGIC (Always check if we have positions in both)
        this.checkPairCost(marketState);

        // Log price occasionally (verbose)
        if (this.config.verbose && Math.random() < 0.05) {
            console.log(color(`[PRICE] ${tokenId.slice(0, 5)}.. $${currentPrice.toFixed(3)}`, COLORS.DIM));
        }
    }

    private async checkOpportunity(state: MarketState, tokenId: string, currentPrice: number, history: PricePoint[]) {
        let highPrice = 0;
        for (const p of history) {
            if (p.price > highPrice) highPrice = p.price;
        }

        if (highPrice > 0 && history.length > 2) {
            // Ignore Low Prices (Noise filter)
            if (this.config.ignorePriceBelow && currentPrice < this.config.ignorePriceBelow) {
                return;
            }

            const drop = (highPrice - currentPrice) / highPrice;
            if (drop >= this.config.dipThreshold) {

                const sideLabel = state.tokenIdToSide.get(tokenId) || "???";
                const sideUpper = sideLabel.toUpperCase();
                const sideState = state.position[sideLabel as 'yes' | 'no'];

                // --- SPAM & RISK CONTROLS ---

                // [FIX 2 - Round 3] Stop Buying if Arb Locked
                if (state.arbLocked) return;

                // [FIX 1] Side Lock
                if (sideState.isBuying) return;

                // [FIX 2] Time Debounce
                if (Date.now() - sideState.lastBuyTs < 2500) return;

                // [SAFETY] Stagnation Check
                if (state.position.yes.totalShares > 0 || state.position.no.totalShares > 0) {
                    if (Date.now() - state.lastImproveTs > 60000) {
                        return; // Paused due to stagnation
                    }
                }

                // [FIX 5] Global Exposure Cap (30% Hard Limit)
                const coinStats = this.pnlManager.getCoinStats(this.config.coin);
                const currentWalletBal = this.pnlManager.getAllStats().walletBalance;

                // Safety fallback if wallet balance is 0 or missing (prevents division by zero or infinite trading)
                if (currentWalletBal > 0) {
                    if (coinStats.currentExposure > currentWalletBal * 0.30) {
                        // We are over-exposed globally. Stop buying.
                        if (Math.random() < 0.01) console.log(color("🛑 Global Exposure Cap Hit (30%). Pause.", COLORS.YELLOW));
                        return;
                    }
                }

                // [SAFETY] Leg 2 Timeout
                // Block accumulation of naked position if time > limit
                // Refined: Uses firstBuyTs (time since WE started the position), not market start.
                const isNakedYes = (sideLabel === 'yes' && state.position.yes.totalShares > 0 && state.position.no.totalShares === 0);
                const isNakedNo = (sideLabel === 'no' && state.position.no.totalShares > 0 && state.position.yes.totalShares === 0);

                if (isNakedYes || isNakedNo) {
                    // If we have shares, we must have a firstBuyTs > 0.
                    const sideFirstBuy = state.position[sideLabel as 'yes' | 'no'].firstBuyTs;
                    const timeSinceEntry = Date.now() - sideFirstBuy;
                    if (timeSinceEntry > this.config.leg2TimeoutSeconds * 1000) {
                        return;
                    }
                }

                // [SAFETY] Hard Market Cap Check (15% of Wallet)

                // [SAFETY] Hard Market Cap Check (15% of Wallet)
                const currentMarketSpent = state.position.yes.totalCost + state.position.no.totalCost;
                if (currentMarketSpent >= state.maxMarketUsd) {
                    return;
                }

                // Imbalance Check
                const yesShares = state.position.yes.totalShares;
                const noShares = state.position.no.totalShares;
                if (sideLabel === 'yes' && yesShares > noShares + (2 * this.config.shares)) return;
                if (sideLabel === 'no' && noShares > yesShares + (2 * this.config.shares)) return;

                // Price Debounce
                if (sideState.lastBuyPrice) {
                    const priceDiff = Math.abs(currentPrice - sideState.lastBuyPrice);
                    if (priceDiff < 0.01) return;
                }

                state.stats.signalsDetected++;

                // Trigger PnL Cycle Start (First Buy)
                if (yesShares === 0 && noShares === 0) {
                    this.pnlManager.startCycle(this.config.coin, state.marketId, state.slug);
                }

                box([
                    color(`🚀 DIP SIGNAL: ${sideUpper}`, COLORS.BRIGHT + COLORS.MAGENTA),
                    `Drop:  ${color((drop * 100).toFixed(1) + "%", COLORS.RED)}`,
                    `Price: ${highPrice.toFixed(3)} -> ${currentPrice.toFixed(3)}`
                ], COLORS.MAGENTA);

                // >>>> EXECUTION LOCK START <<<<
                sideState.isBuying = true;

                try {
                    // Execute BUY - returns filled shares
                    // [RISK REFINED] Pass currentSideCost for logging, but logic handled inside
                    const filledShares = await this.executeOrder(tokenId, this.config.shares, currentPrice, `BUY ${sideUpper}`);

                    if (filledShares > 0) {
                        sideState.buysTriggered++;

                        // CRITICAL STATE UPDATE
                        if (sideState.totalShares === 0) {
                            sideState.firstBuyTs = Date.now(); // Initialize entry time
                        }
                        sideState.totalShares += filledShares;
                        sideState.totalCost += (filledShares * currentPrice); // Add actual cost
                        sideState.avgPrice = sideState.totalCost / sideState.totalShares;
                        sideState.lastBuyPrice = currentPrice;

                        // [FIX 2] Update Time De-bounce
                        sideState.lastBuyTs = Date.now();

                        // Update PnL State (Exposure)
                        this.pnlManager.updateCycleCost(state.marketId, state.position.yes.totalCost, state.position.no.totalCost);

                        // Trigger Balance update
                        if (this.clobClient) {
                            this.updatePnlBalance();
                        }

                        console.log(color(`✅ Added ${filledShares} ${sideUpper}. New Avg: ${sideState.avgPrice.toFixed(4)}`, COLORS.GREEN));
                    }
                } finally {
                    // >>>> EXECUTION LOCK RELEASE <<<<
                    sideState.isBuying = false;
                }
            }
        }
    }

    private async updatePnlBalance() {
        if (!this.clobClient) return;
        try {
            const res = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            const bal = parseFloat((res as any).balance || "0") / 1e6;
            this.pnlManager.updateWalletBalance(bal);
        } catch (e) { }
    }

    private async executeOrder(
        tokenId: string,
        requestedShares: number,
        price: number,
        label: string,
        bypassRisk: boolean = false // [NEW] Allow force hedges to exceed 5% cap
    ): Promise<number> {
        if (!this.clobClient) return 0;

        const balRes = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const availableUsd = parseFloat((balRes as any).balance || "0") / 1e6;
        this.pnlManager.updateWalletBalance(availableUsd);

        // [RISK] Risk Cap Logic (Dynamic)
        // If wallet < $20, allow 50% risk (Aggressive Degen Mode).
        // Otherwise, stick to 15% for safety.
        // User requested strict adherence to this cap for TOTAL hedge cost.
        const riskPct = availableUsd < 20 ? 0.50 : 0.15;

        let maxSharesRisk = requestedShares;

        if (!bypassRisk) {
            const maxLiabilityUsd = availableUsd * riskPct;

            // [FIX] Strict Liability-Based Sizing
            // Total "Hedge Budget" is 25% of wallet (e.g. $3.25).
            // This budget must cover the entire potential liability ($1.00/share).
            const liabilityPrice = 1.0;
            maxSharesRisk = Math.floor(maxLiabilityUsd / liabilityPrice);

            if (maxSharesRisk <= 0) {
                console.log(color(`[${label}] Risk Check Failed: Bal $${availableUsd.toFixed(2)} too low for liability sizing (Max shares: ${maxSharesRisk})`, COLORS.RED));
                return 0;
            }
        } else {
            // Forced Hedge: Take whatever we can get
            maxSharesRisk = Math.floor(availableUsd / price);
        }

        // [FIX] Dynamic Min-Size Fetching
        // CLOB often enforces min sizes > 1 share. We must check.
        let minShares = 1;
        try {
            const book = await this.clobClient.getOrderBook(tokenId);
            // API usually returns 'min_order_size' or similar. 
            // Based on user logs: "Size (2) lower than the minimum: 5"
            // We'll trust the book object.
            if ((book as any).min_order_size) {
                minShares = parseFloat((book as any).min_order_size);
            }
        } catch (e) {
            console.log(color(`[${label}] Failed to fetch min size, defaulting to 1`, COLORS.YELLOW));
        }

        let finalShares = Math.min(requestedShares, maxSharesRisk);

        // [FIX] Strict Min-Size Check (Do NOT override risk)
        if (!bypassRisk && finalShares < minShares) {
            console.log(color(`[${label}] Risk Check Failed: Required Min Size (${minShares}) > Max Safe Shares (${finalShares}). Trade Aborted.`, COLORS.RED));
            return 0;
        }

        // Final sanity check
        if (finalShares < minShares && !bypassRisk) return 0;

        // For forced hedge...
        if (finalShares < minShares) {
            if (bypassRisk) {
                // Try to force Min Size for hedge if we are close?
                // No, if we can't afford it, likely rejection.
                if (finalShares <= 0) return 0;
            } else {
                return 0;
            }
        }

        const exactCost = finalShares * price;

        if (!bypassRisk && !WalletGuard.tryReserve(exactCost, availableUsd)) {
            console.log(color(`[${label}] WalletGuard Blocked`, COLORS.RED));
            return 0;
        }

        try {
            console.log(color(`[${label}] BUY ${finalShares} @ $${price}`, COLORS.CYAN));

            const order = await this.clobClient.createAndPostOrder(
                { tokenID: tokenId, price, side: Side.BUY, size: finalShares },
                { tickSize: "0.01" }
            );

            if (order?.orderID) {
                console.log(color(`[${label}] Success ${order.orderID}`, COLORS.GREEN));
                return finalShares; // funds intentionally NOT released
            }

            WalletGuard.release(exactCost);
            return 0;
        } catch (e: any) {
            WalletGuard.release(exactCost);
            console.log(color(`[${label}] Failed: ${e.message}`, COLORS.DIM));
            return 0;
        }
    }

    private checkPairCost(state: MarketState) {
        if (state.status === 'complete' || state.status === 'EXITING' || state.status === 'partial_unwind') return; // Strict Guard

        const yes = state.position.yes;
        const no = state.position.no;

        if (yes.totalShares > 0 && no.totalShares > 0) {
            const pairCost = yes.avgPrice + no.avgPrice;

            // Convergence Tracking
            if (pairCost < state.bestPairCost) {
                state.bestPairCost = pairCost;
                state.lastImproveTs = Date.now();
            }

            if (pairCost <= this.config.sumTarget) {
                // [FIX BUG 1] Infinite Trigger Guard
                if (state.arbLocked) return;

                // [FIX BUG 1 & 2] State Machine Transition which stops re-entry
                state.arbLocked = true;
                state.status = 'complete'; // Stop scanning, stop calling checks

                // Calculate realized profit approximation (Matched Shares)
                const matchedShares = Math.min(yes.totalShares, no.totalShares);
                const profitPerPair = 1.0 - pairCost;
                const totalProfit = matchedShares * profitPerPair;

                // Update PnL Manager
                // [FIX] Convert Sum Target Win to ARB_LOCKED (Unrealized)
                // We do NOT add profit here because it is not realized until redemption.
                console.log(color("✅ SUM TARGET HIT! Locking Arb for Expiry.", COLORS.GREEN));

                // Record as ARB_LOCKED with 0 realized PnL for now
                // This is now safe because status='complete' prevents re-run.
                this.pnlManager.closeCycle(state.marketId, "ARB_LOCKED", 0);

                this.logResult(state, pairCost, totalProfit);
            }
        }
    }

    private logHeader() {
        box([
            `    ${color("THE SMART APE - GABAGOOL STRATEGY", COLORS.BRIGHT + COLORS.CYAN)}    `,
            "",
            `Coin:        ${this.config.coin}`,
            `Mode:        ${color("CONTINUOUS ACCUMULATION", COLORS.GREEN)}`,
            `Dip:         ${(this.config.dipThreshold * 100).toFixed(0)}% drop trigger`,
            `Target Cost: ${this.config.sumTarget} (AvgYes + AvgNo)`,
            `Sizing:      Dynamic (Max 5% risk, Max 25% inv)`,
        ], COLORS.CYAN);
    }

    private logResult(state: MarketState, pairCost: number, estimatedProfit: number) {
        box([
            color("🏆 STRATEGY COMPLETE - TARGET REACHED", COLORS.BRIGHT + COLORS.YELLOW),
            `Avg Yes:    $${state.position.yes.avgPrice.toFixed(4)} (${state.position.yes.totalShares})`,
            `Avg No:     $${state.position.no.avgPrice.toFixed(4)} (${state.position.no.totalShares})`,
            `Pair Cost:  $${pairCost.toFixed(4)}`,
            `Est Profit: $${estimatedProfit.toFixed(4)}`
        ], COLORS.YELLOW);
    }

    // --- EARLY EXIT LOGIC ---
    private async checkAndExecuteEarlyExit(state: MarketState) {
        if (!this.config.earlyExit?.enabled || !this.clobClient) return;
        // [STRICT GUARD] Must be holding/active (scanning) and not already exiting
        if (state.status !== 'scanning') return;

        const yes = state.position.yes;
        const no = state.position.no;

        // Must hold both sides
        if (yes.totalShares <= 0 || no.totalShares <= 0) return;

        try {
            // 1. Fetch REAL Orderbook (L2)
            const yesBook = await this.clobClient.getOrderBook(state.tokenIds[0]);
            const noBook = await this.clobClient.getOrderBook(state.tokenIds[1]);

            if (!yesBook.bids.length || !noBook.bids.length) return;

            // 2. Liquidity & Size Check
            const matchShares = Math.min(yes.totalShares, no.totalShares);
            if (!this.hasSufficientLiquidity(yesBook.bids, matchShares) ||
                !this.hasSufficientLiquidity(noBook.bids, matchShares)) {
                return;
            }

            const bestBidYes = parseFloat(yesBook.bids[0].price);
            const bestBidNo = parseFloat(noBook.bids[0].price);

            // 3. Profit & Slippage Check
            const exitValue = bestBidYes + bestBidNo;
            const entryCost = yes.avgPrice + no.avgPrice;

            const profitPerShare = exitValue - entryCost;
            const profitPct = profitPerShare / entryCost;
            const totalProfitUsd = profitPerShare * matchShares;

            if (profitPct < (this.config.earlyExit.minProfitPct || 0.15)) return;
            if (totalProfitUsd < (this.config.earlyExit.minProfitUsd || 0.50)) return;

            // 4. EXECUTION
            console.log(color(`\n💰 EARLY EXIT VALID: +${(profitPct * 100).toFixed(1)}% ($${totalProfitUsd.toFixed(2)})`, COLORS.BRIGHT + COLORS.GREEN));

            // LOCK STATE IMMEDIATELY
            state.status = 'EXITING';

            // Determine Order: Sell Thinner Side First
            // Strategy: Calculate total depth at best price, sell lower depth first.
            const yesDepth = this.getBidDepth(yesBook.bids, bestBidYes);
            const noDepth = this.getBidDepth(noBook.bids, bestBidNo);

            let firstSide, secondSide;
            if (yesDepth < noDepth) {
                firstSide = { id: state.tokenIds[0], price: bestBidYes, name: 'YES', amount: matchShares };
                secondSide = { id: state.tokenIds[1], price: bestBidNo, name: 'NO', amount: matchShares };
            } else {
                firstSide = { id: state.tokenIds[1], price: bestBidNo, name: 'NO', amount: matchShares };
                secondSide = { id: state.tokenIds[0], price: bestBidYes, name: 'YES', amount: matchShares };
            }

            console.log(color(`   Strategy: Selling ${firstSide.name} (Depth: ${yesDepth < noDepth ? yesDepth : noDepth}) then ${secondSide.name}`, COLORS.DIM));

            // SELL LEG 1 (Thinner Side)
            console.log(color(`   🚀 Selling Leg 1 (${firstSide.name})...`, COLORS.CYAN));
            const sold1 = await this.executeSell(firstSide.id, firstSide.amount, firstSide.price, "EXIT-1");

            if (sold1 === 0) {
                console.log(color("   ❌ Leg 1 Failed. Aborting Exit. Unlocking.", COLORS.RED));
                state.status = 'scanning'; // Revert lock (using 'active' as 'not complete/exiting')
                return;
            }

            // SELL LEG 2 (Thicker Side)
            console.log(color(`   🚀 Selling Leg 2 (${secondSide.name})...`, COLORS.CYAN));
            const sold2 = await this.executeSell(secondSide.id, secondSide.amount, secondSide.price, "EXIT-2");

            if (sold2 === 0) {
                // CRITICAL FAILURE: Leg 1 sold, Leg 2 stuck. Naked Risk.
                console.error(color("   💀 CRITICAL: LEG 2 FAILED. EXECS EMERGENCY HEDGE.", COLORS.BG_RED + COLORS.WHITE));
                // Panic Price: 30% haircut (0.7 * bestBid)
                const panicPrice = secondSide.price * 0.7;
                await this.emergencyHedge(secondSide.id, secondSide.amount, panicPrice, "EXIT-FAIL-HEDGE");

                // Force closure even if messy
                state.status = 'complete';
                this.pnlManager.closeCycle(state.marketId, "ABANDON", -matchShares * firstSide.price); // Rough loss usage
                return;
            }

            // Success
            state.position.yes.totalShares = 0;
            state.position.no.totalShares = 0;
            state.status = 'complete'; // Finalize

            this.pnlManager.closeCycle(state.marketId, "EARLY_EXIT", totalProfitUsd);
            console.log(color("   ✅ Early Exit Complete.", COLORS.GREEN));

        } catch (e) {
            console.error("Error early exit:", e);
            state.status = 'scanning'; // Unlock on error
        }
    }

    private hasSufficientLiquidity(bids: any[], needed: number): boolean {
        let cum = 0;
        for (const b of bids) {
            cum += parseFloat(b.size);
            if (cum >= needed) return true;
        }
        return false;
    }

    private getBidDepth(bids: any[], price: number): number {
        let depth = 0;
        for (const b of bids) {
            if (parseFloat(b.price) >= price) {
                depth += parseFloat(b.size);
            }
        }
        return depth;
    }

    // --- LATE DOMINANCE EXIT LOGIC ---
    private async checkAndExecuteLateExit(state: MarketState) {
        if (!this.config.lateExit?.enabled || !this.clobClient) return;
        // [STRICT GUARD] Only allow exit if currently in normal scanning mode
        if (state.status !== 'scanning') return;


        const yes = state.position.yes;
        const no = state.position.no;

        // Must hold positions
        if (yes.totalShares <= 0 || no.totalShares <= 0) return;

        const timeLeftMs = state.endTime - Date.now();
        const triggerTime = (this.config.lateExit.timeRemainingSeconds || 60) * 1000;

        if (timeLeftMs > triggerTime) return; // Not late enough

        try {
            // 1. Fetch Orderbook
            const yesBook = await this.clobClient.getOrderBook(state.tokenIds[0]);
            const noBook = await this.clobClient.getOrderBook(state.tokenIds[1]);

            if (!yesBook.bids.length || !noBook.bids.length) return;

            // 2. Determine Dominance
            const bestBidYes = parseFloat(yesBook.bids[0].price);
            const bestBidNo = parseFloat(noBook.bids[0].price);

            const winnerPrice = Math.max(bestBidYes, bestBidNo);
            const loserPrice = Math.min(bestBidYes, bestBidNo);

            const minDominance = this.config.lateExit.minWinnerPrice || 0.70;
            const maxLoser = 1.0 - minDominance; // e.g. 0.30

            // Condition: One side > 0.70 AND Other side < 0.30 (implied, but check safe)
            if (winnerPrice < minDominance) return;
            if (loserPrice > maxLoser) return; // Should be impossible if spread exists, but safe check

            // 3. Profit Check
            const matchShares = Math.min(yes.totalShares, no.totalShares);
            const exitValue = bestBidYes + bestBidNo;
            const entryCost = yes.avgPrice + no.avgPrice;
            const profitPerShare = exitValue - entryCost;
            const totalProfitUsd = profitPerShare * matchShares;

            const minProfit = this.config.lateExit.minProfitUsd || 0.01;
            if (totalProfitUsd < minProfit) return; // Don't exit for loss

            // 4. EXECUTION
            console.log(color(`\n⚡ LATE DOMINANCE EXIT TRIGGERED (${(timeLeftMs / 1000).toFixed(1)}s left)`, COLORS.BRIGHT + COLORS.MAGENTA));
            console.log(color(`   Winner: ${winnerPrice.toFixed(2)} | Loser: ${loserPrice.toFixed(2)} | Profit: $${totalProfitUsd.toFixed(2)}`, COLORS.MAGENTA));

            state.status = 'EXITING';

            // Identify IDs
            // Assume YES is token 0, NO is token 1
            const isYesWinner = bestBidYes > bestBidNo;
            const winnerSide = {
                id: state.tokenIds[isYesWinner ? 0 : 1],
                price: isYesWinner ? bestBidYes : bestBidNo,
                name: isYesWinner ? 'YES' : 'NO'
            };
            const loserSide = {
                id: state.tokenIds[isYesWinner ? 1 : 0],
                price: isYesWinner ? bestBidNo : bestBidYes,
                name: isYesWinner ? 'NO' : 'YES'
            };

            // SELL WINNER FIRST (Liquid Side)
            console.log(color(`   🚀 Selling Winner (${winnerSide.name})...`, COLORS.CYAN));
            const soldWin = await this.executeSell(winnerSide.id, matchShares, winnerSide.price, "LATE-EXIT-WIN");

            if (soldWin === 0) {
                console.log(color("   ❌ Winner Sell Failed. Aborting Late Exit.", COLORS.RED));
                state.status = 'scanning';
                return;
            }

            // SELL LOSER IMMEDIATELY
            console.log(color(`   🚀 Selling Loser (${loserSide.name})...`, COLORS.CYAN));
            const soldLose = await this.executeSell(loserSide.id, matchShares, loserSide.price, "LATE-EXIT-LOSE");

            if (soldLose === 0) {
                // Panic dump loser? It's likely very cheap anyway (e.g. 0.05 vs 0.30 target)
                // Use emergency hedge logic
                console.error(color("   ⚠️ Loser Sell Failed. Dumping...", COLORS.YELLOW));
                await this.emergencyHedge(loserSide.id, matchShares, loserSide.price * 0.7, "LATE-FAIL-HEDGE");
                // Proceed to complete even if hedge is messy
                // PnL calc uses optimistic exit value since we sold winner, loser is negligible part
                // but strictly we should use actuals. 
            }

            // Correct State Mutation: Zero out shares since we exited everything
            state.position.yes.totalShares = 0;
            state.position.no.totalShares = 0;
            state.status = 'complete';

            this.pnlManager.closeCycle(state.marketId, "LATE_EXIT", totalProfitUsd); // Use LATE_EXIT code
            console.log(color("   ✅ Late Exit Complete.", COLORS.GREEN));

        } catch (e) {
            console.error("Error late exit:", e);
            state.status = 'scanning';
        }
    }

    // --- PARTIAL UNWIND (WINNER-ONLY EXIT) ---
    private async checkAndExecutePartialUnwind(state: MarketState) {
        if (!this.config.partialUnwind?.enabled || !this.clobClient) return;
        // [STRICT GUARD] Only allow exit if currently in normal scanning mode
        if (state.status !== 'scanning') return;

        const yes = state.position.yes;
        const no = state.position.no;

        // Must hold positions
        if (yes.totalShares <= 0 || no.totalShares <= 0) return;

        const timeLeftMs = state.endTime - Date.now();
        const triggerTime = (this.config.partialUnwind.timeRemainingSeconds || 45) * 1000;

        if (timeLeftMs > triggerTime) return; // Not late enough

        try {
            // 1. Fetch Orderbook
            const yesBook = await this.clobClient.getOrderBook(state.tokenIds[0]);
            const noBook = await this.clobClient.getOrderBook(state.tokenIds[1]);

            if (!yesBook.bids.length || !noBook.bids.length) return;

            // 2. Determine Dominance (Winner)
            const bestBidYes = parseFloat(yesBook.bids[0].price);
            const bestBidNo = parseFloat(noBook.bids[0].price);

            const isYesWinner = bestBidYes > bestBidNo;
            const winnerPrice = isYesWinner ? bestBidYes : bestBidNo;
            const winnerSideState = isYesWinner ? yes : no;

            const minWinnerPrice = this.config.partialUnwind.minWinnerPrice || 0.70;
            if (winnerPrice < minWinnerPrice) return;

            // 3. Profit Check (Winner Only)
            const sharesToSell = winnerSideState.totalShares;
            const winnerPnLPerShare = winnerPrice - winnerSideState.avgPrice;
            const totalWinnerProfit = winnerPnLPerShare * sharesToSell; // [FIX] Compare total profit
            const minProfit = this.config.partialUnwind.minProfitUsd || 0.20;

            if (totalWinnerProfit < minProfit) return;

            // [FIX] Liquidity Check
            if (!this.hasSufficientLiquidity(isYesWinner ? yesBook.bids : noBook.bids, sharesToSell)) {
                return; // Not enough depth to absorb sell
            }

            // 4. EXECUTION
            console.log(color(`\n🧘 PARTIAL UNWIND TRIGGERED (${(timeLeftMs / 1000).toFixed(1)}s left)`, COLORS.BRIGHT + COLORS.CYAN));
            console.log(color(`   Winner: ${winnerPrice.toFixed(2)} | Profit: $${totalWinnerProfit.toFixed(2)}`, COLORS.CYAN));
            console.log(color(`   Action: Selling Winner Only. Holding Loser as free roll.`, COLORS.CYAN));

            // Lock State
            state.status = 'partial_unwind';

            const winnerSide = {
                id: state.tokenIds[isYesWinner ? 0 : 1],
                price: winnerPrice,
                name: isYesWinner ? 'YES' : 'NO'
            };



            // EXECUTE SELL
            const soldShares = await this.executeSell(winnerSide.id, sharesToSell, winnerSide.price, "PARTIAL-UNWIND");

            if (soldShares === 0) {
                console.log(color("   ❌ Partial Unwind Sell Failed. Reverting to scanning.", COLORS.RED));
                state.status = 'scanning';
                return;
            }

            // SUCCESS - UPDATE STATE
            // [FIX] Zero out Cost and AvgPrice to prevent ghost losses if cycle is later Abandoned
            winnerSideState.totalShares = 0;
            winnerSideState.totalCost = 0;
            winnerSideState.avgPrice = 0;

            // [FIX] Log Realized Profit immediately
            this.pnlManager.logPartialProfit(state.marketId, totalWinnerProfit);

            // [FIX 3] Sync Exposure
            this.pnlManager.updateCycleCost(state.marketId, state.position.yes.totalCost, state.position.no.totalCost);

            // We do NOT zero out the loser side. We keep it.
            // We do NOT close the cycle. The cycle is still open until expiry or manual redemption.

            console.log(color("   ✅ Partial Unwind Complete. Winner sold. Loser held.", COLORS.GREEN));

        } catch (e) {
            console.error("Error partial unwind:", e);
            state.status = 'scanning';
        }
    }

    private async forceCloseMarket(state: MarketState): Promise<void> {
        console.log(color(`[FORCE CLOSE] Liquidating ${state.slug}`, COLORS.MAGENTA));

        for (const [side, idx] of [['yes', 0], ['no', 1]] as const) {
            const sideKey = side as 'yes' | 'no';
            const qty = state.position[sideKey].totalShares;

            if (qty <= 0) continue;

            try {
                const book = await this.clobClient!.getOrderBook(state.tokenIds[idx]);
                if (!book.bids.length) {
                    console.log(color(`   ⚠️ No liquidity for ${side.toUpperCase()} force close.`, COLORS.YELLOW));
                    continue;
                }

                const bestBid = parseFloat(book.bids[0].price);
                // Reduce checks, just sell.
                await this.executeSell(state.tokenIds[idx], qty, bestBid, `FORCE-CLOSE-${side.toUpperCase()}`);
            } catch (e) {
                console.error(`   ❌ Failed to force close ${side.toUpperCase()}:`, e);
            }
        }

        // 3. Final Redemption Check (just in case)
        try {
            await redeemPositions();
        } catch (e) { }
    }

    private async emergencyHedge(tokenId: string, quantity: number, price: number, label: string) {
        try {
            console.log(color(`[${label}] PANIC DUMP ${quantity} @ ${price.toFixed(3)}`, COLORS.RED));
            await this.executeSell(tokenId, quantity, price, label);
        } catch (e) {
            console.error("Emergency hedge failed", e);
        }
    }

    private async executeSell(tokenId: string, quantity: number, price: number, label: string): Promise<number> {
        if (!this.clobClient) return 0;
        try {
            console.log(color(`[${label}] SELLING ${quantity} @ $${price}`, COLORS.YELLOW));
            const order = await this.clobClient.createAndPostOrder(
                { tokenID: tokenId, price, side: Side.SELL, size: quantity },
                { tickSize: "0.01" }
            );
            if (order?.orderID) {
                console.log(color(`[${label}] Success ${order.orderID}`, COLORS.GREEN));
                return quantity;
            }
            return 0;
        } catch (e: any) {
            console.log(color(`[${label}] Failed: ${e.message}`, COLORS.RED));
            return 0;
        }
    }
    // [FIX 5] Equity Calculation
    private async calculateEquity(): Promise<number> {
        let usdcBal = this.pnlManager.getAllStats().walletBalance;
        if (usdcBal < 0) usdcBal = 0; // Sanity

        let tokenValue = 0;

        for (const state of this.activeMarkets.values()) {
            for (const [side, idx] of [['yes', 0], ['no', 1]] as const) {
                const qty = state.position[side as 'yes' | 'no'].totalShares;
                if (qty > 0) {
                    const lastPxStr = this.getLastPrice(state, idx);
                    const lastPx = parseFloat(lastPxStr);
                    if (!isNaN(lastPx)) {
                        tokenValue += qty * lastPx;
                    }
                }
            }
        }

        return usdcBal + tokenValue;
    }
}


