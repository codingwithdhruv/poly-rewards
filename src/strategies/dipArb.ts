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

    status: 'scanning' | 'complete';
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
            dashboard: config.dashboard || false
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
        // 1. Cleanup old market
        if (this.activeMarkets.size > 0) {
            // Check if we need to close stats as LOSS/ABANDON
            for (const state of this.activeMarkets.values()) {
                if (state.status === 'scanning' && (state.position.yes.totalShares > 0 || state.position.no.totalShares > 0)) {
                    // Market ended without profit lock
                    // [SAFETY] Pessimistic Loss Implementation
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

        const maxMarketUsd = walletBal * 0.15;

        // Log Selection
        box([
            `Selected: ${color(targetMarket.slug, COLORS.BRIGHT)}`,
            `Question: ${targetMarket.question}`,
            `Start:    ${new Date(startTime).toLocaleTimeString()} (${timeUntilStart > 0 ? "in " + (timeUntilStart / 60000).toFixed(1) + "m" : "Active"})`,
            `End:      ${new Date(endTime).toLocaleTimeString()}`,
            `Info:     ${color(`Max Exposure: $${maxMarketUsd.toFixed(2)} (15%)`, COLORS.MAGENTA)}`,
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

            // [SAFETY] Daily Drawdown Kill Switch (5%)
            if (this.pnlManager.checkDrawdown(0.05)) {
                console.error(color("\n💀 FATAL: DAILY DRAWDOWN LIMIT EXCEEDED (5%). SHUTTING DOWN.", COLORS.BG_RED + COLORS.WHITE));
                process.exit(1);
            }

            // [SAFETY] LEG-1 ABORT: Force Hedge if Timeout
            // Detect Naked Position
            const isNakedYes = (state.position.yes.totalShares > 0 && state.position.no.totalShares === 0);
            const isNakedNo = (state.position.no.totalShares > 0 && state.position.yes.totalShares === 0);

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
                            "FORCED-HEDGE"
                        );

                        if (filledShares > 0) {
                            // [FIX STATE] Manually update local state since executeOrder doesn't do it for us here
                            const oppSideState = state.position[oppositeSide];
                            oppSideState.totalShares += filledShares;
                            oppSideState.totalCost += filledShares * oppPrice;
                            oppSideState.avgPrice = oppSideState.totalCost / oppSideState.totalShares;

                            // [CRITICAL] POST-HEDGE LOCK
                            // Mark cycle complete to block further "optimizing" of a bad pair.
                            // We are now locked in a (likely losing) pair, waiting for expiry.
                            state.status = 'complete';
                            console.log(color(`🔒 PAIR LOCKED (Forced Hedge: ${filledShares} ${oppositeSide.toUpperCase()}). Waiting for expiry...`, COLORS.MAGENTA));
                        } else {
                            console.log(color("❌ Forced Hedge Failed: executeOrder returned 0.", COLORS.RED));
                        }

                    } else {
                        console.log(color("❌ Could not force hedge: Price unavailable.", COLORS.RED));
                    }
                }
            }

            // AUTOMATIC ROTATION TRIGGER (Market End)
            if (timeLeft <= 0) {
                console.log(color(`[STATUS] Market ${state.slug} has ENDED.`, COLORS.YELLOW));
                // [SAFETY] Pessimistic Loss
                if (state.position.yes.totalShares > 0 || state.position.no.totalShares > 0) {
                    const lossAmount = state.position.yes.totalCost + state.position.no.totalCost;
                    this.pnlManager.closeCycle(state.marketId, 'LOSS', -lossAmount);
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
        label: string
    ): Promise<number> {
        if (!this.clobClient) return 0;

        const balRes = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const availableUsd = parseFloat((balRes as any).balance || "0") / 1e6;
        this.pnlManager.updateWalletBalance(availableUsd);

        const maxUsd = availableUsd * 0.05;
        const maxSharesRisk = Math.floor(maxUsd / price);
        if (maxSharesRisk <= 0) return 0;

        const minShares = Math.ceil(1.0 / price);
        let finalShares = Math.min(requestedShares, maxSharesRisk);
        if (finalShares < minShares) finalShares = minShares;

        const exactCost = finalShares * price;

        if (!WalletGuard.tryReserve(exactCost, availableUsd)) {
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
                state.status = 'complete';

                // Calculate realized profit approximation (Matched Shares)
                const matchedShares = Math.min(yes.totalShares, no.totalShares);
                const profitPerPair = 1.0 - pairCost;
                const totalProfit = matchedShares * profitPerPair;

                // Update PnL Manager
                this.pnlManager.closeCycle(state.marketId, 'WIN', totalProfit);

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
}
