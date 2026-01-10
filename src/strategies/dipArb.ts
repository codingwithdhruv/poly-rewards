import { Strategy } from "./types.js";
import { ClobClient, Side, AssetType } from "@polymarket/clob-client";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { GammaClient } from "../clients/gamma-api.js";
import { PriceSocket, PriceUpdate } from "../clients/websocket.js";

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

interface MarketState {
    marketId: string;
    tokenIds: string[]; // [YesToken, NoToken]
    prices: Map<string, PricePoint[]>; // History for each token
    position: {
        leg1: { filled: boolean; side: Side; price: number; tokenId: string; amount: number };
        leg2: { filled: boolean; side: Side; price: number; tokenId: string; amount: number };
    };
    status: 'scanning' | 'leg1_filled' | 'leg2_filled' | 'complete' | 'window_closed';
    endTime: number;
    startTime: number;
    slug: string;
    question: string;
    stats: {
        signalsDetected: number;
        leg1Filled: number;
        leg2Filled: number;
    };
}

export interface DipArbConfig {
    coin: string;
    dipThreshold: number;      // movePct
    slidingWindowMs: number;
    sumTarget: number;
    shares: number;
    leg2TimeoutSeconds: number;
    windowMinutes: number;     // Entry allowed only in first N mins
    ignorePriceBelow?: number; // Ignore dips if price is below this (e.g. 0.05)
    verbose?: boolean;
    info?: boolean;
    redeem?: boolean;
}

export class DipArbStrategy implements Strategy {
    name = "DipArbitrage";
    private clobClient?: ClobClient;
    private gammaClient: GammaClient;
    private priceSocket: PriceSocket;

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
            windowMinutes: config.windowMinutes || 2,
            ignorePriceBelow: config.ignorePriceBelow || 0,
            verbose: config.verbose || false
        };

        this.gammaClient = new GammaClient();
        this.priceSocket = new PriceSocket(this.onPriceUpdate.bind(this));
    }

    async init(clobClient: ClobClient, relayClient: RelayClient): Promise<void> {
        this.clobClient = clobClient;

        // AUTO-APPROVE ALLOWANCE
        try {
            const res = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });

            // Parse allowances map (max of all spenders)
            const allowances = (res as any).allowances ? Object.values((res as any).allowances).map((a: any) => parseFloat(a)) : [];
            const allowance = allowances.length > 0 ? Math.max(...allowances) : 0;

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

        // Start the rotation loop
        await this.rotateToNextMarket();
    }

    /**
     * Finds the next suitable market and starts monitoring it.
     */
    private async rotateToNextMarket(): Promise<void> {
        // 1. Cleanup old market
        if (this.activeMarkets.size > 0) {
            console.log(color("\n🔄 Rotating to next market...", COLORS.CYAN));
            this.priceSocket.close(); // Unsubscribe all
            this.activeMarkets.clear();
            if (this.statusInterval) clearInterval(this.statusInterval);
        }

        // 2. Scan loop (retry until found)
        let markets: any[] = [];
        let attempts = 0;

        console.log(`[${this.name}] Scanning for ${this.config.coin} 15m markets...`);

        while (markets.length === 0) {
            markets = await this.scanUpcomingMarkets(this.config.coin, '15m');

            // Filter only markets that haven't ended yet
            markets = markets.filter(m => {
                const endTime = new Date(m.events?.[0]?.endDate || m.endDateIso).getTime();
                return endTime > Date.now();
            });

            if (markets.length === 0) {
                attempts++;
                if (attempts % 6 === 0) console.log(color("Waiting for new markets...", COLORS.DIM));
                await new Promise(r => setTimeout(r, 5000)); // Wait 5s
            }
        }

        // 3. Select best market (Soonest expiration)
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
            return this.rotateToNextMarket(); // Retry
        }

        // Times
        const endTimeStr = targetMarket.events?.[0]?.endDate || targetMarket.endDateIso;
        const endTime = new Date(endTimeStr).getTime();

        // Infer Start Time
        const slugParts = targetMarket.slug.split('-');
        let startTime = endTime - 15 * 60 * 1000;
        const timestampInSlug = parseInt(slugParts[slugParts.length - 1]);
        if (!isNaN(timestampInSlug)) {
            startTime = timestampInSlug * 1000;
        }

        const timeUntilStart = startTime - Date.now();

        // Log Selection
        box([
            `Selected: ${color(targetMarket.slug, COLORS.BRIGHT)}`,
            `Question: ${targetMarket.question}`,
            `Start:    ${new Date(startTime).toLocaleTimeString()} (${timeUntilStart > 0 ? "in " + (timeUntilStart / 60000).toFixed(1) + "m" : "Active"})`,
            `End:      ${new Date(endTime).toLocaleTimeString()}`,
            `Status:   ${color("WATCHING", COLORS.GREEN)}`
        ], COLORS.CYAN);

        if (tokenIds.length === 2) {
            this.activeMarkets.set(targetMarket.id, {
                marketId: targetMarket.id,
                tokenIds: tokenIds,
                prices: new Map(),
                position: {
                    leg1: { filled: false, side: Side.BUY, price: 0, tokenId: "", amount: 0 },
                    leg2: { filled: false, side: Side.BUY, price: 0, tokenId: "", amount: 0 }
                },
                status: 'scanning',
                endTime: endTime,
                startTime: startTime,
                slug: targetMarket.slug,
                question: targetMarket.question,
                stats: { signalsDetected: 0, leg1Filled: 0, leg2Filled: 0 }
            });

            this.priceSocket.connect(tokenIds);
            this.startStatusLoop();

        } else {
            console.error(color("Invalid market token count.", COLORS.RED));
            setTimeout(() => this.rotateToNextMarket(), 5000); // Retry
        }
    }

    private startStatusLoop() {
        if (this.statusInterval) clearInterval(this.statusInterval);
        this.statusInterval = setInterval(() => this.checkStatusAndRotate(), 5000);
    }

    private checkStatusAndRotate() {
        let activeCount = 0;

        for (const state of this.activeMarkets.values()) {
            const now = Date.now();
            const timeLeft = Math.round((state.endTime - now) / 1000);

            // AUTOMATIC ROTATION TRIGGER
            if (timeLeft <= 0) {
                console.log(color(`[STATUS] Market ${state.slug} has ENDED.`, COLORS.YELLOW));
                this.rotateToNextMarket();
                return; // Exit loop, rotation handles reset
            }

            activeCount++;

            // Calculate Window Status
            const minutesSinceStart = (now - state.startTime) / 60000;
            const inWindow = minutesSinceStart <= this.config.windowMinutes;
            const windowStr = inWindow
                ? color(`OPEN (${(this.config.windowMinutes - minutesSinceStart).toFixed(1)}m left)`, COLORS.GREEN)
                : color("CLOSED", COLORS.RED);

            // Time String
            const timeStr = `${Math.floor(timeLeft / 60)}m ${timeLeft % 60}s`;

            // Prices
            const p1 = this.getLastPrice(state, 0);
            const p2 = this.getLastPrice(state, 1);

            // Stats
            const statsStr = `Sig: ${color(state.stats.signalsDetected.toString(), COLORS.YELLOW)} | L1: ${state.stats.leg1Filled} | L2: ${state.stats.leg2Filled}`;

            // Console Output 
            console.log(
                `${color("[STATUS]", COLORS.CYAN)} ` +
                `Time: ${timeStr.padEnd(9)} | ` +
                `Window: ${windowStr} | ` +
                `Price: ${color(p1, COLORS.GREEN)}/${color(p2, COLORS.RED)} | ` +
                `${statsStr}`
            );
        }

        if (activeCount === 0) {
            // Should not happen if logic is correct, but safety net
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

    async run(): Promise<void> { }
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

        // Update History
        if (!marketState.prices.has(tokenId)) marketState.prices.set(tokenId, []);
        const history = marketState.prices.get(tokenId)!;
        history.push({ price: currentPrice, timestamp: now });

        // Prune older than 3s (slidingWindowMs)
        const cutoff = now - this.config.slidingWindowMs;
        while (history.length > 0 && history[0].timestamp < cutoff) history.shift();

        // Logic
        if (marketState.status === 'scanning') {
            // CHECK WINDOW CONSTRAINT
            const minutesSinceStart = (now - marketState.startTime) / 60000;
            if (minutesSinceStart > this.config.windowMinutes) {
                // Window closed
                marketState.status = 'window_closed';
                return;
            }

            this.checkLeg1(marketState, tokenId, currentPrice, history);

        } else if (marketState.status === 'leg1_filled') {
            // Leg 2 allowed anytime
            this.checkLeg2(marketState, tokenId, currentPrice);
        }

        // Log price occasionally (verbose)
        if (this.config.verbose && Math.random() < 0.05) {
            console.log(color(`[PRICE] ${tokenId.slice(0, 5)}.. $${currentPrice.toFixed(3)}`, COLORS.DIM));
        }
    }

    private async checkLeg1(state: MarketState, tokenId: string, currentPrice: number, history: PricePoint[]) {
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
                state.stats.signalsDetected++;

                box([
                    color("🚀 DIP SIGNAL DETECTED", COLORS.BRIGHT + COLORS.MAGENTA),
                    `Token: ${tokenId}`,
                    `Drop:  ${color((drop * 100).toFixed(1) + "%", COLORS.RED)}`,
                    `Price: ${highPrice.toFixed(3)} -> ${currentPrice.toFixed(3)}`
                ], COLORS.MAGENTA);

                state.status = 'leg1_filled';

                const success = await this.executeOrder(tokenId, this.config.shares, currentPrice, "LEG 1 (DIP)");
                if (success) {
                    state.stats.leg1Filled++;
                    state.position.leg1 = {
                        filled: true, side: Side.BUY, price: currentPrice, tokenId: tokenId, amount: this.config.shares
                    };
                    console.log(color("✅ LEG 1 FILLED. Hunting for Hedge...", COLORS.GREEN));
                } else {
                    state.status = 'scanning';
                }
            }
        }
    }

    private async checkLeg2(state: MarketState, tokenId: string, currentPrice: number) {
        const leg1Token = state.position.leg1.tokenId;
        if (tokenId === leg1Token) return;

        // Cost = Leg1 (Paid) + Leg2 (Current)
        const totalCost = state.position.leg1.price + currentPrice;

        if (totalCost <= this.config.sumTarget) {
            state.status = 'leg2_filled';

            box([
                color("💰 HEDGE OPPORTUNITY", COLORS.BRIGHT + COLORS.GREEN),
                `Opposite: ${tokenId}`,
                `Leg1 Price: ${state.position.leg1.price.toFixed(3)}`,
                `Curr Price: ${currentPrice.toFixed(3)}`,
                `Total Cost: ${color(totalCost.toFixed(3), COLORS.YELLOW)} (Target < ${this.config.sumTarget})`
            ], COLORS.GREEN);

            const success = await this.executeOrder(tokenId, this.config.shares, currentPrice, "LEG 2 (HEDGE)");
            if (success) {
                state.stats.leg2Filled++;
                state.position.leg2 = {
                    filled: true, side: Side.BUY, price: currentPrice, tokenId: tokenId, amount: this.config.shares
                };
                state.status = 'complete';
                this.logResult(state);
            } else {
                state.status = 'leg1_filled';
            }
        }
    }

    private async executeOrder(tokenId: string, requestedShares: number, price: number, label: string): Promise<boolean> {
        if (!this.clobClient) return false;
        try {
            const minAmount = 1.0;
            const minShares = Math.ceil(minAmount / price);
            let finalShares = requestedShares;
            if (finalShares < minShares) {
                finalShares = minShares;
                console.log(color(`[${label}] Resized to ${finalShares} shares (Min $1)`, COLORS.YELLOW));
            }

            console.log(color(`[${label}] Sending BUY ${finalShares} @ $${price}...`, COLORS.CYAN));

            const order = await this.clobClient.createAndPostOrder({
                tokenID: tokenId,
                price: price,
                side: Side.BUY,
                size: finalShares,
            }, {
                tickSize: "0.01"
            });

            if (order && order.orderID) {
                console.log(color(`[${label}] Success! ID: ${order.orderID}`, COLORS.GREEN));
                return true;
            }
            return false;
        } catch (e: any) {
            console.error(color(`[${label}] Order Failed: ${e.message}`, COLORS.RED));
            return false;
        }
    }

    private logHeader() {
        box([
            `    ${color("THE SMART APE - DIP ARBITRAGE BOT", COLORS.BRIGHT + COLORS.CYAN)}    `,
            "",
            `Coin:        ${this.config.coin}`,
            `Window:      ${this.config.windowMinutes} mins (Only trade early)`,
            `Dip:         ${(this.config.dipThreshold * 100).toFixed(0)}% in 3s`,
            `Sum Target:  ${this.config.sumTarget}`,
            `Shares:      ${this.config.shares}`,
            `Rotation:    ${color("ENABLED", COLORS.GREEN)}`,
        ], COLORS.CYAN);
    }

    private logResult(state: MarketState) {
        const cost = state.position.leg1.price + state.position.leg2.price;
        const profit = 1 - cost;
        const profitPercent = (profit / cost) * 100;

        box([
            color("🏆 ROUND COMPLETE", COLORS.BRIGHT + COLORS.YELLOW),
            `Total Cost: $${cost.toFixed(3)}`,
            `Profit:     $${profit.toFixed(3)} (${profitPercent.toFixed(1)}%)`
        ], COLORS.YELLOW);
    }
}
