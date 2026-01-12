import { Strategy } from "./types.js";
import { ClobClient, Side, AssetType } from "@polymarket/clob-client";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { PriceSocket, PriceUpdate } from "../clients/websocket.js";
import { GammaClient } from "../clients/gamma-api.js";
import { PnlManager } from "../lib/pnlManager.js";
import { WalletGuard } from "../lib/walletGuard.js";

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

// ================= CONFIG =================
export interface TrueArbConfig {
    coin: string;
    maxRiskPct: number;        // % of wallet per arb
    maxPairCost: number;       // e.g. 0.97
    minEdgeUsd: number;        // e.g. $0.02
    minLiquidityShares: number;
    tickSize: number;
}

// ================= STRATEGY =================
export class TruePairArbStrategy implements Strategy {
    name = "TRUE PAIR ARBITRAGE";
    private clob?: ClobClient;
    private gamma = new GammaClient();
    private socket: PriceSocket;
    private pnl = new PnlManager();
    private cfg: TrueArbConfig;
    private prices = new Map<string, number>();
    private tokenIds: string[] = [];
    private executing = false;

    // Status & Rotation
    private marketId?: string;
    private marketSlug?: string;
    private marketQuestion?: string;
    private marketEndTime: number = 0;
    private statusInterval?: NodeJS.Timeout;
    private active = false;

    constructor(cfg: Partial<TrueArbConfig> = {}) {
        this.cfg = {
            coin: cfg.coin || "BTC",
            maxRiskPct: cfg.maxRiskPct ?? 0.05,
            maxPairCost: cfg.maxPairCost ?? 0.97,
            minEdgeUsd: cfg.minEdgeUsd ?? 0.02,
            minLiquidityShares: cfg.minLiquidityShares ?? 5,
            tickSize: cfg.tickSize ?? 0.01
        };
        this.socket = new PriceSocket(this.onPrice.bind(this));
    }

    async init(clob: ClobClient, _relay: RelayClient) {
        this.clob = clob;
        const bal = await clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const usd = parseFloat((bal as any).balance) / 1e6;
        this.pnl.updateWalletBalance(usd);
        await this.selectMarket();
    }

    // ================= MARKET =================
    private async selectMarket(): Promise<void> {
        console.log(`[TrueArb] Scanning for ${this.cfg.coin} 15m markets...`);

        // 1. Generate potential slugs for the next 2 hours
        const duration = '15m';
        const intervalSeconds = 900;
        const nowSeconds = Math.floor(Date.now() / 1000);

        // Align to 15m grid
        const minSlotStart = Math.floor((nowSeconds - intervalSeconds) / intervalSeconds) * intervalSeconds;
        const maxSlotStart = minSlotStart + (2 * 60 * 60); // Scan 2 hours ahead

        const slugsToFetch: string[] = [];
        const coinLower = this.cfg.coin.toLowerCase();

        for (let t = minSlotStart; t <= maxSlotStart; t += intervalSeconds) {
            slugsToFetch.push(`${coinLower}-updown-${duration}-${t}`);
        }

        // 2. Fetch and find active
        let targetMarket: any = null;

        for (const slug of slugsToFetch) {
            try {
                // console.log(`[Debug] Checking ${slug}...`);
                const results = await this.gamma.getMarkets(`slug=${slug}`);
                if (results && results.length > 0) {
                    const m = results[0];
                    const endTime = new Date(m.events?.[0]?.endDate || m.endDateIso).getTime();

                    if (m.active && !m.closed && endTime > Date.now()) {
                        // Found valid market
                        targetMarket = m;
                        break; // Grab the first valid one (soonest expiring usually, or current)
                    }
                }
            } catch (e) {
                // ignore 404s
            }
        }

        if (!targetMarket) {
            console.log("[TrueArb] No active markets found. Retrying in 5s...");
            await new Promise(r => setTimeout(r, 5000));
            return this.selectMarket(); // Retry recursion
        }

        // Setup Market State
        this.tokenIds = JSON.parse(targetMarket.clobTokenIds);
        this.marketId = targetMarket.id;
        this.marketSlug = targetMarket.slug;
        this.marketQuestion = targetMarket.question;
        const endTimeStr = targetMarket.events?.[0]?.endDate || targetMarket.endDateIso;
        this.marketEndTime = new Date(endTimeStr).getTime();

        this.socket.connect(this.tokenIds);
        console.log(`[TrueArb] Connected to ${targetMarket.slug}`);
        console.log(color(`[TrueArb] Question: ${targetMarket.question}`, COLORS.CYAN));

        // Start Status Loop
        this.startStatusLoop();
    }

    // ================= PRICE HANDLER =================
    private onPrice(update: PriceUpdate) {
        this.prices.set(update.asset_id, parseFloat(update.price));
        if (this.prices.size === 2) this.tryArb();
    }

    // ================= CORE LOGIC =================
    private async tryArb() {
        if (this.executing || !this.clob) return;

        const [yesId, noId] = this.tokenIds;
        // Check if we have both prices
        if (!this.prices.has(yesId) || !this.prices.has(noId)) return;

        const yesPx = this.prices.get(yesId)!;
        const noPx = this.prices.get(noId)!;
        const pairCost = yesPx + noPx;

        if (pairCost > this.cfg.maxPairCost) return;

        const edge = 1.0 - pairCost;
        if (edge < this.cfg.minEdgeUsd) return;

        // --- EXECUTION CHECK ---
        const balRes = await this.clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const walletUsd = parseFloat((balRes as any).balance) / 1e6;

        // Dynamic Sizing
        const maxUsd = walletUsd * this.cfg.maxRiskPct;
        const shares = Math.floor(maxUsd / Math.max(yesPx, noPx));

        if (shares < this.cfg.minLiquidityShares) return;

        const cost = shares * pairCost;
        if (!WalletGuard.tryReserve(cost, walletUsd)) return;

        this.executing = true;
        try {
            console.log(
                `⚡ ARB FOUND | YES ${yesPx.toFixed(3)} + NO ${noPx.toFixed(3)} = ${pairCost.toFixed(3)}`
            );

            // Atomic-ish Execution (Back-to-Back)
            const yes = await this.clob.createAndPostOrder(
                { tokenID: yesId, price: yesPx, side: Side.BUY, size: shares },
                { tickSize: this.cfg.tickSize.toString() as any }
            );
            if (!yes?.orderID) throw new Error("YES failed");

            const no = await this.clob.createAndPostOrder(
                { tokenID: noId, price: noPx, side: Side.BUY, size: shares },
                { tickSize: this.cfg.tickSize.toString() as any }
            );
            if (!no?.orderID) throw new Error("NO failed");

            const profit = shares * edge;
            this.pnl.startCycle(this.cfg.coin, "ARB", "PAIR");
            this.pnl.closeCycle("ARB", "WIN", profit);
            console.log(`✅ ARB LOCKED | Profit ≈ $${profit.toFixed(4)}`);

        } catch (e) {
            console.error("❌ ARB FAILED — ABORTING");
            // Since we failed, we release the reserved funds
            WalletGuard.release(cost);
        } finally {
            this.executing = false;
        }
    }

    async run() {
        this.active = true;
        // Keep process alive via Promise
        return new Promise<void>(() => { });
    }

    private startStatusLoop() {
        if (this.statusInterval) clearInterval(this.statusInterval);

        this.statusInterval = setInterval(async () => {
            if (!this.active) return;

            // 1. Check Drawdown (Safety)
            if (this.pnl.checkDrawdown(0.05)) {
                console.error(color("\n💀 FATAL: DAILY DRAWDOWN LIMIT EXCEEDED (5%). SHUTTING DOWN.", COLORS.BG_RED + COLORS.WHITE));
                process.exit(1);
            }

            // 2. Check Market End (Rotation)
            const now = Date.now();
            const timeLeft = Math.round((this.marketEndTime - now) / 1000);

            if (timeLeft <= 0) {
                console.log(color(`[STATUS] Market ${this.marketSlug} has ENDED. Rotating...`, COLORS.YELLOW));
                await this.cleanup();
                this.socket.close(); // Ensure socket closed
                await this.selectMarket(); // Find next
                return;
            }

            // 3. Log Status
            const [yesId, noId] = this.tokenIds;
            const yesPx = this.prices.get(yesId) || 0;
            const noPx = this.prices.get(noId) || 0;
            const pairCost = yesPx + noPx;
            const spread = 1.0 - pairCost;

            // Format
            const timeStr = `${Math.floor(timeLeft / 60)}m ${timeLeft % 60}s`;
            const costColor = pairCost <= this.cfg.maxPairCost ? COLORS.GREEN : COLORS.DIM;

            process.stdout.write(`\r[${color(timeStr, COLORS.WHITE)}] Cost: ${color(pairCost.toFixed(3), costColor)} | Spread: ${(spread * 100).toFixed(1)}% | Risk: ${this.cfg.maxRiskPct * 100}%  `);

        }, 1000);
    }

    async cleanup() {
        if (this.statusInterval) clearInterval(this.statusInterval);
        this.socket.close();
    }
}
