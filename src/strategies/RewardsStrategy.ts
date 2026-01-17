import { ClobClient, OrderType, Side, TickSize, MarketReward, AssetType, ApiKeyCreds } from "@polymarket/clob-client";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { Strategy } from "./types.js";
import { GammaClient, GammaMarket } from "../clients/gamma-api.js";
import { REWARDS_CONFIG } from "../config/rewardsConfig.js";
import { CONFIG } from "../clients/config.js";
import * as MarketUtils from "../lib/marketUtils.js";
import { ethers } from "ethers";
import WebSocket from "ws";
import * as ScoringCalc from "../lib/scoringCalculator.js";
import { analyzeLiquidity, calculateAsymmetricDistances, analyzeDepthBands, DepthBands } from "../lib/orderbookAnalyzer.js";
import * as OrderbookAnalyzer from "../lib/orderbookAnalyzer.js"; // Helper to get types if needed
import { mergePositions } from "../lib/ctfHelper.js";

interface TrackedOrder {
    orderId: string;
    tokenId: string;
    price: number;
    side: Side;
    size: number;
    placedAt: number;
    ladderLevel?: number;      // Which ladder level (0, 1, etc.)
    expectedScore?: number;    // Calculated reward score
}

type BotMode = "QUOTING" | "MANAGING" | "FROZEN";

interface MarketState {
    marketId: string;
    gammaMarket: GammaMarket;
    tier: 1 | 2 | 3;
    score: number;
    orders: TrackedOrder[]; // Local order tracking
    lastUpdate: number;
    isFrozen: boolean;
    // Market specific params for signing and rewards
    yesTokenId: string;
    noTokenId: string;
    tickSize: TickSize; // STRICT TYPING "0.1" | "0.01" ...
    negRisk: boolean;
    rewardsMinSize: number;
    rewardsMaxSpread?: number;
    dnCost?: number; // Estimated Delta Neutral Cost
    yesPrice?: number;
    noPrice?: number;
    yesCost?: number;
    noCost?: number;
    dynamicStoploss?: number; // Store the calculated SL for this batch
    minCapitalRequired?: number; // New: Min shares * (Yes + No prices)
    capitalEfficiencyScore?: number; // New: Rewards / MinCapital
    dailyRewards?: number; // For Gem detection
    competition?: number;  // For Gem detection


    // Inventory & Mode Tracking
    mode: BotMode;
    inventory: {
        yes: number;
        no: number;
    };
    lastFillTime?: number;
    // Phase 8: Liquidity Pressure State
    pressureState?: {
        yesDistance: number;
        noDistance: number;
        yesExhaustionCycles: number; // Consecutive cycles with low depth
        noExhaustionCycles: number;
        // Phase 18: Replenishment Tracking
        yesLastDepth1?: number;
        yesLastDepthTs?: number;
        noLastDepth1?: number;
        noLastDepthTs?: number;
    }
    // Phase 16: Midpoint Tolerance
    lastQuotedMid?: number;
    // Phase 19: Trade Velocity Tracking (TTC Model)
    tradeVelocity?: {
        recentTrades: Array<{ timestamp: number; value: number }>;
        usdcPerSecond: number;
        lastUpdate: number;
    };
}


export class RewardsStrategy implements Strategy {
    name = "rewards-farming";
    private clobClient!: ClobClient;
    private relayClient!: RelayClient;
    private gammaClient!: GammaClient;
    private isRunning = false;

    private activeMarkets: Map<string, MarketState> = new Map();
    private markets: MarketState[] = [];
    private lastRotationTime = 0;
    private lowBalancePauseUntil: number = 0; // Timestamp to resume placing orders
    private scanInterval: NodeJS.Timeout | null = null;
    // Phase 3: Market Selection & Scaling & Blacklisting
    private blacklist: Map<string, number> = new Map(); // marketId -> cooldownUntil
    private fillTrackers: Map<string, number[]> = new Map(); // marketId -> [fillTimestamps]
    private lastGlobalLogTime = 0;

    // Phase 4: Risk & Latency
    private priceHistory: Map<string, { timestamp: number, mid: number }[]> = new Map();
    private tradeHistory: Map<string, number[]> = new Map(); // public trade timestamps

    // Phase 5 & 6: Temporal & Performance
    private lastDashboardLogTime = 0;
    private lastScoringCheckTime = 0;
    private globalTrackingBalance = 0; // Fix 2: Global liquidity tracking
    private marketStats: Map<string, {
        fills: number,
        lastFills: number,
        startTime: number,
        cumulativeRewards: number,
        isScoring: boolean
    }> = new Map();

    // WS Client
    private ws: WebSocket | null = null;
    private creds?: ApiKeyCreds;
    private pingInterval: NodeJS.Timeout | null = null; // Phase 23: Proactive PING

    // Custom Filter for single market mode
    private customFilter?: string;
    private customSpread?: number;
    private customAvoid?: number;

    constructor(customFilter?: string, customSpread?: number, customAvoid?: number, creds?: ApiKeyCreds) {
        this.customFilter = customFilter;
        this.customSpread = customSpread;
        this.customAvoid = customAvoid;
        this.creds = creds;
        if (customFilter) {
            console.log(`[Custom Mode] Filter: "${customFilter}", Spread: ${customSpread || 0.01} ($), Avoid: ${customAvoid || 0.005} ($)`);
        }
    }

    // cache: tokenId -> { data: any, ts: number }
    private obCache: Map<string, { data: any, ts: number }> = new Map();

    private async getOrderBookCached(tokenId: string) {
        const now = Date.now();
        const cached = this.obCache.get(tokenId);
        // 2s TTL
        if (cached && (now - cached.ts < 2000)) {
            return cached.data;
        }

        try {
            const data = await this.clobClient.getOrderBook(tokenId);
            this.obCache.set(tokenId, { data, ts: now });
            return data;
        } catch (e) {
            console.error(`Failed to fetch OB for ${tokenId}`, e);
            return null;
        }
    }

    private async getMidpointFromAPI(tokenId: string): Promise<number | null> {
        try {
            const res = await this.clobClient.getMidpoint(tokenId);
            return parseFloat(res.mid);
        } catch (e) {
            // console.warn(`Failed to get midpoint for ${tokenId}:`, e);
            return null;
        }
    }

    async init(clobClient: ClobClient, relayClient: RelayClient) {
        this.clobClient = clobClient;
        this.relayClient = relayClient;
        this.gammaClient = new GammaClient();
        console.log("Rewards Strategy Initialized"); // v2.0 Production

        if (this.creds) {
            this.initUserStream();
        } else {
            console.warn("[WS] No API Credentials provided. Fill detection disabled!");
        }
    }

    private initUserStream() {
        if (!this.creds) return;

        console.log("[WS] Connecting to User Channel (via /ws/user)...");
        this.ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/user");

        this.ws.on("open", () => {
            console.log("[WS] Connected. Authenticating...");
            const authMsg = {
                type: "user",
                auth: {
                    apiKey: this.creds!.key,
                    secret: this.creds!.secret,
                    passphrase: this.creds!.passphrase
                }
            };
            this.ws?.send(JSON.stringify(authMsg));

            // Phase 23: Start proactive PING to keep connection alive
            this.startPingInterval();
        });

        this.ws.on("message", (data: any) => {
            try {
                const strData = data.toString();

                // Phase 23: Handle PING/PONG keep-alive messages
                if (strData === "PING" || strData === "ping") {
                    this.ws?.send("PONG");
                    return;
                }

                if (strData === "PONG" || strData === "pong") {
                    // Server acknowledged our PING, ignore
                    return;
                }

                if (strData === "INVALID OPERATION") {
                    console.error("[WS] Server returned INVALID OPERATION. Check auth payload.");
                    return;
                }
                const msg = JSON.parse(strData);
                if (msg.event_type === "trade" && (msg.status === "MATCHED" || msg.status === "MINED")) {
                    this.handleFill(msg);
                }
                if (msg.event_type === "error") {
                    console.error("[WS] Error:", msg.message);
                }
            } catch (e) {
                console.error("[WS] Parse error:", e, "Raw:", data.toString());
            }
        });

        this.ws.on("error", (err) => console.error("[WS] Connection Error:", err));
        this.ws.on("close", () => {
            console.warn("[WS] Closed. Reconnecting in 5s...");
            this.stopPingInterval(); // Phase 23: Clean up interval
            setTimeout(() => this.initUserStream(), 5000);
        });
    }

    // Phase 23: Proactive PING to keep WebSocket alive
    private startPingInterval() {
        this.stopPingInterval(); // Clear any existing
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send("PING");
            }
        }, 10000); // Every 10 seconds
    }

    private stopPingInterval() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    private handleFill(msg: any) {
        // msg: { asset_id, side: "BUY"|"SELL", size, price, ... }
        // NOTE: side is FROM THE MAKER'S PERSPECTIVE? Or Taker?
        // Usually User Channel 'side' is YOUR side. A BUY means YOU BOUGHT.

        // Find market by asset_id (token_id)
        let foundState: MarketState | undefined;
        let isYes = false;

        for (const state of this.activeMarkets.values()) {
            if (state.yesTokenId === msg.asset_id) {
                foundState = state;
                isYes = true;
                break;
            }
            if (state.noTokenId === msg.asset_id) {
                foundState = state;
                isYes = false;
                break;
            }
        }

        if (foundState) {
            console.log(`[FILL DETECTED] ${foundState.gammaMarket.question.slice(0, 20)} | ${msg.side} ${msg.size} @ ${msg.price}`);

            // Phase 3: Toxic Fill Tracking
            const now = Date.now();
            const fills = this.fillTrackers.get(foundState.marketId) || [];
            const windowStart = now - REWARDS_CONFIG.SCALING_AND_ROTATION.TOXIC_WINDOW_MS;
            const recentFills = fills.filter(t => t > windowStart);
            recentFills.push(now);
            this.fillTrackers.set(foundState.marketId, recentFills);

            if (recentFills.length >= REWARDS_CONFIG.SCALING_AND_ROTATION.TOXIC_FILL_THRESHOLD) {
                const cooldown = REWARDS_CONFIG.SCALING_AND_ROTATION.BLACKLIST_COOLDOWN_MS;
                console.warn(`[TOXICITY] Market ${foundState.marketId} filled ${recentFills.length}x in window. Blacklisting for ${cooldown / 3600000}h.`);
                this.blacklist.set(foundState.marketId, now + cooldown);
                // Force rotation in next loop by letting it be 'managing' then cleared
            }

            // Phase 5 & 6: Stat Tracking
            const stats = this.marketStats.get(foundState.marketId) || { fills: 0, lastFills: 0, startTime: Date.now(), cumulativeRewards: 0, isScoring: true };
            stats.fills += 1;
            this.marketStats.set(foundState.marketId, stats);

            // Switch to Managing Mode immediately
            foundState.mode = "MANAGING";
            foundState.lastFillTime = Date.now();

            // Phase 22: CRITICAL - Initialize inventory if undefined
            if (!foundState.inventory) {
                foundState.inventory = { yes: 0, no: 0 };
            }

            // Update estimated inventory (API sync verifies later)
            const size = parseFloat(msg.size);
            if (msg.side === "BUY") {
                if (isYes) foundState.inventory.yes += size;
                else foundState.inventory.no += size;
            } else {
                if (isYes) foundState.inventory.yes -= size;
                else foundState.inventory.no -= size;
            }

            // Phase 22: DEBUG - Log inventory state
            console.log(`[FILL] Inventory after: YES=${foundState.inventory.yes.toFixed(2)}, NO=${foundState.inventory.no.toFixed(2)}`);
        }
    }

    private updatePriceHistory(marketId: string, mid: number) {
        const now = Date.now();
        const history = this.priceHistory.get(marketId) || [];
        history.push({ timestamp: now, mid });

        // Prune old data
        const oneMinuteAgo = now - REWARDS_CONFIG.RISK_MANAGEMENT.VOLATILITY_WINDOW_MS;
        const pruned = history.filter(h => h.timestamp > oneMinuteAgo);
        this.priceHistory.set(marketId, pruned);
    }

    private calculateVolatility(marketId: string): number {
        const history = this.priceHistory.get(marketId) || [];
        if (history.length < REWARDS_CONFIG.RISK_MANAGEMENT.VOLATILITY_MIN_DATA_POINTS) return 0;

        const mids = history.map(h => h.mid);
        const mean = mids.reduce((a, b) => a + b, 0) / mids.length;
        const squareDiffs = mids.map(m => Math.pow(m - mean, 2));
        const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / squareDiffs.length;
        return Math.sqrt(avgSquareDiff);
    }

    private getCurrentRiskMultiplier(): number {
        if (!REWARDS_CONFIG.TEMPORAL.ENABLE_TEMPORAL_ALPHA) return 1.0;

        const hour = new Date().getHours();
        const isLowActivity = REWARDS_CONFIG.TEMPORAL.LOW_ACTIVITY_HOURS.includes(hour);

        return isLowActivity
            ? REWARDS_CONFIG.TEMPORAL.RISK_PROFILE.LOW_ACTIVITY_MULTIPLIER
            : REWARDS_CONFIG.TEMPORAL.RISK_PROFILE.HIGH_ACTIVITY_MULTIPLIER;
    }

    private printPerformanceDashboard() {
        console.log(`\n================================================================================`);
        console.log(`PRODUCTION PERFORMANCE DASHBOARD | ${new Date().toLocaleTimeString()} `);
        console.log(`--------------------------------------------------------------------------------`);
        console.log(`Market                         | Fills | Start Time | Rewards Est | Scoring?`);
        console.log(`-------------------------------|-------|------------|-------------|---------`);

        for (const [id, state] of this.activeMarkets.entries()) {
            const stats = this.marketStats.get(id) || { fills: 0, lastFills: 0, startTime: Date.now(), cumulativeRewards: 0, isScoring: true };
            const mktName = state.gammaMarket.question.slice(0, 30).padEnd(30, " ");
            const startTimeStr = new Date(stats.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const rewards = state.gammaMarket.clobRewards?.[0]?.rewardsDailyRate || 0;
            const scoringStr = stats.isScoring ? "YES" : "NO!!";

            console.log(`${mktName} | ${stats.fills.toString().padEnd(5)} | ${startTimeStr.padEnd(10)} | $${rewards.toFixed(2).padEnd(10)} | ${scoringStr}`);
        }
        console.log(`================================================================================\n`);
    }

    private printLogHeader() {
        console.log(`Time      | Market                         | Action       | Spread   | Target   | StopLoss | Details`);
        console.log(`----------|--------------------------------|--------------|----------|----------|----------|----------------------------------------`);
    }

    private logAction(market: string, action: string, spread: number, target: number, stoploss: number, details: string) {
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        const mktName = market.length > 30 ? market.substring(0, 27) + "..." : market.padEnd(30, " ");

        // Colors
        const RESET = "\x1b[0m";
        const RED = "\x1b[31m";
        const GREEN = "\x1b[32m";
        const YELLOW = "\x1b[33m";
        const CYAN = "\x1b[36m";

        let color = RESET;
        if (action === "REQUOTE" || action === "POST") color = GREEN;
        if (action === "CANCEL" || action === "COMPRESS" || action === "DRIFT") color = RED;
        if (action === "CONFIG" || action === "LOW FUNDS") color = YELLOW;
        if (action === "PAUSED") color = CYAN;

        const actionStr = action.padEnd(12, " ");
        const spreadStr = spread > 0 ? spread.toFixed(4) : "-";
        const targetStr = target > 0 ? target.toFixed(4) : "-";
        const slStr = stoploss > 0 ? stoploss.toFixed(4) : "-";

        console.log(`${color}${time}  | ${mktName} | ${actionStr} | ${spreadStr.padEnd(8, " ")} | ${targetStr.padEnd(8, " ")} | ${slStr.padEnd(8, " ")} | ${details}${RESET}`);
    }

    async run() {
        this.isRunning = true;
        console.log("Starting Rewards Strategy Loop...");

        await this.scanAndRotate();
        this.printLogHeader();

        let loopCount = 0;

        while (this.isRunning) {
            try {
                const now = Date.now();
                loopCount++;

                // FIX 2: Refresh Global Liquidity
                try {
                    const bal = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                    this.globalTrackingBalance = parseFloat(bal.balance) / 1e6;
                } catch (e) {
                    // keep previous balance if fail
                }

                // Reprint header occasionally (every 20 loops)
                if (loopCount % 20 === 0) this.printLogHeader();

                // 1. Fill Avoidance (High Frequency)
                await this.runFillAvoidance();


                // 2. Market Rotation (Low Frequency)
                // Every 30 mins
                if (now - this.lastRotationTime > REWARDS_CONFIG.MONITORING.RECALC_INTERVAL_MS) {
                    await this.scanAndRotate();
                }

                // 2.1 Dashboard & Scoring Monitor (Phase 6)
                if (now - this.lastDashboardLogTime > REWARDS_CONFIG.MONITORING_ADVANCED.DASHBOARD_INTERVAL_MS) {
                    this.lastDashboardLogTime = now;
                    this.printPerformanceDashboard();
                }

                // 2.2 Scoring Verification (Phase 5)
                if (now - this.lastScoringCheckTime > REWARDS_CONFIG.MONITORING_ADVANCED.SCORING_CHECK_INTERVAL_MS) {
                    this.lastScoringCheckTime = now;
                    for (const [mid, state] of this.activeMarkets.entries()) {
                        try {
                            // FIX 1: Filter to BUY orders only (SELLs don't reliably score)
                            const scoringOrders = state.orders.filter(o => o.side === Side.BUY);
                            if (scoringOrders.length === 0) continue;

                            const scoringRes = await this.clobClient.areOrdersScoring({ orderIds: scoringOrders.map(o => o.orderId) });
                            const scoringMap = (scoringRes as any).scoring || scoringRes; // Handle both structures

                            // Check if ANY of our orders are scoring
                            let scoringCount = 0;
                            const orderIds = scoringOrders.map(o => o.orderId);
                            for (const id of orderIds) {
                                if (scoringMap[id] === true) scoringCount++;
                            }

                            const isScoring = scoringCount === orderIds.length; // True only if ALL are scoring
                            const stats = this.marketStats.get(mid) || { fills: 0, lastFills: 0, startTime: now, cumulativeRewards: 0, isScoring: true };
                            stats.isScoring = isScoring;
                            this.marketStats.set(mid, stats);

                            if (!isScoring) {
                                this.logAction(state.gammaMarket.question, "PENALTY", -1, -1, -1, `⚠️ Only ${scoringCount}/${orderIds.length} orders are SCORING`);
                            }
                        } catch (e) { /* ignore */ }
                    }
                }

                // 3. Order Management (Placement/Update)
                for (const [marketId, state] of this.activeMarkets.entries()) {
                    if (state.isFrozen) {
                        // TODO: Check for unfreeze condition (e.g. time passed)
                        continue;
                    }

                    // MANAGING MODE (Priority)
                    if (state.mode === "MANAGING") {
                        await this.runPositionManagement(state);
                        continue;
                    }

                    // QUOTING MODE
                    // 3. Risk Management (Fill Avoidance) - ALWAYS RUN
                    await this.runFillAvoidance(state);

                    // 4. Order Management (Requote/Place) - SKIP IF PAUSED (Low Funds)
                    if (Date.now() < this.lowBalancePauseUntil) {
                        this.logAction(state.gammaMarket.question, "PAUSED", -1, -1, -1, `Paused for funds. Resumes in ${((this.lowBalancePauseUntil - Date.now()) / 1000).toFixed(0)}s.`);
                        continue;
                    }

                    await this.manageMarketOrders(state);
                }

                await new Promise(r => setTimeout(r, 2000)); // 2s loop
            } catch (e) {
                console.error("Error in Strategy Loop:", e);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }

    async cleanup() {
        this.isRunning = false;
        console.log("Cleaning up Rewards Strategy...");
        await this.cancelAllOrders();
    }

    private async cancelAllOrders() {
        console.log("Cancelling all active orders...");
        for (const [marketId, state] of this.activeMarkets.entries()) {
            if (state.orders.length > 0) {
                try {
                    await this.clobClient.cancelOrders(state.orders.map(o => o.orderId));
                    state.orders = [];
                } catch (e) {
                    console.error(`Failed to cancel orders for ${marketId}:`, e);
                }
            }
        }
    }

    private async fetchClobRewards(): Promise<Map<string, any>> {
        const map = new Map<string, any>();
        console.log("Fetching Reward Markets from CLOB...");

        try {
            // Simplified fetch: single call
            const res = await this.clobClient.getSamplingMarkets();

            if (res.data) {
                for (const m of res.data) {
                    map.set(m.condition_id, m);
                }
            } else if (Array.isArray(res)) {
                for (const m of res) {
                    map.set(m.condition_id, m);
                }
            }

            // FALLBACK: If Custom Filter is set, search Gamma API specifically
            if (this.customFilter) {
                console.log(`[Custom Mode] Searching Gamma for "${this.customFilter}"...`);
                try {
                    const searchRes = await this.gammaClient.getMarkets(`active=true&closed=false&q=${encodeURIComponent(this.customFilter)}`);
                    console.log(`[Custom Mode] Gamma found ${searchRes.length} matches.`);

                    for (const m of searchRes) {
                        if (!map.has(m.conditionId)) {
                            // Fetch details from CLOB to ensure we have 'tokens' structure
                            try {
                                const details = await this.clobClient.getMarket(m.conditionId);
                                if (details) {
                                    console.log(`[Custom Debug] CLOB returned: question="${details.question}", tokens=${details.tokens?.length}`);
                                    // Also copy the question from Gamma if CLOB doesn't have it
                                    if (!details.question && m.question) {
                                        details.question = m.question;
                                    }
                                    map.set(m.conditionId, details);
                                }
                            } catch (err) {
                                console.warn(`Failed to fetch CLOB details for ${m.question}:`, err);
                            }
                        }
                    }
                } catch (e) {
                    console.error("Gamma Search failed:", e);
                }
            }

            console.log(`Fetched ${map.size} markets (Rewards + Custom Search).`);
        } catch (e) {
            console.error("Error fetching CLOB rewards:", e);
        }
        return map;
    }

    // --- Market Selection & Rotation ---

    private async scanAndRotate() {
        console.log("Scanning markets for rotation (Source: CLOB Only)...");
        this.lastRotationTime = Date.now();

        try {
            // 1. Fetch official Rewards Data from CLOB (Source of Truth)
            const rewardMap = await this.fetchClobRewards();

            // Fetch Balance for Capital Awareness
            let availableUSDC = 0;
            try {
                const balRes = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                availableUSDC = parseFloat(balRes.balance) / 1e6;
            } catch (e) {
                console.error("Failed to fetch balance during scan:", e);
                // Fallback: If we can't get balance, assume we have some (or 0 to be safe, but 0 blocks everything)
                // Let's assume we can proceed but with caution? Or maybe just skip filtering if fails?
                // Better to skip filtering if balance fetch fails to avoid bricking.
                availableUSDC = 999999;
            }

            console.log(`Processing ${rewardMap.size} markets from CLOB... | Balance: $${availableUSDC.toFixed(2)}`);

            const candidates: MarketState[] = [];
            let processed = 0;

            for (const [conditionId, market] of rewardMap.entries()) {
                processed++;
                // LIVE COUNTER: Overwrite line
                if (processed % 10 === 0 || processed === rewardMap.size) {
                    process.stdout.write(`\rProcessing markets... ${processed}/${rewardMap.size}`);
                }

                if (market.question?.includes("15 Min") || market.question?.includes("15 min")) continue;

                // CUSTOM FILTER
                if (this.customFilter) {
                    const qLower = market.question.toLowerCase();
                    const fLower = this.customFilter.toLowerCase();
                    if (!qLower.includes(fLower)) {
                        continue;
                    }
                    // If matched, force logic to accept it even if low volume/tier
                }

                // 2. Extract Data directly from CLOB Object
                // REWARDS
                let dailyRewards = 0;
                if (market.rewards?.rates && Array.isArray(market.rewards.rates)) {
                    for (const rate of market.rewards.rates) {
                        dailyRewards += Number(rate.rewards_daily_rate || 0);
                    }
                }

                // CUSTOM FILTER LOGGING
                if (this.customFilter) {
                    const qLower = market.question.toLowerCase();
                    const fLower = this.customFilter.toLowerCase();
                    if (qLower.includes(fLower)) {
                        console.log(`[Custom Match] ${market.question}`);
                        console.log(`  - Rewards: ${dailyRewards}`);
                        console.log(`  - Tokens: ${market.tokens?.length}`);
                        console.log(`  - EndDate: ${market.end_date_iso}`);
                    }
                }

                if (dailyRewards <= 0 && !this.customFilter) continue;

                // TOKENS
                if (!market.tokens || market.tokens.length < 2) {
                    if (this.customFilter && market.question.toLowerCase().includes(this.customFilter.toLowerCase())) {
                        console.warn(`[Custom Match] SKIPPED due to missing tokens! Length: ${market.tokens?.length}`);
                    }
                    continue;
                }
                const yesToken = market.tokens.find((t: any) => t.outcome === "Yes");
                const noToken = market.tokens.find((t: any) => t.outcome === "No");

                if (!yesToken || !noToken) {
                    if (this.customFilter && market.question.toLowerCase().includes(this.customFilter.toLowerCase())) {
                        console.warn(`[Custom Match] SKIPPED due to missing YES/NO token IDs!`);
                    }
                    continue;
                }

                const yesTokenId = yesToken.token_id;
                const noTokenId = noToken.token_id;

                // RESOLUTION
                const endStr = market.end_date_iso || "";
                if (!endStr && !this.customFilter) continue;

                const end = new Date(endStr);
                const hoursToRes = (end.getTime() - Date.now()) / (1000 * 60 * 60);

                if (hoursToRes < REWARDS_CONFIG.HARD_LIMITS.MIN_RESOLUTION_HOURS && !this.customFilter) continue;

                // REWARD PARAMS
                const minShares = Number(market.rewards?.min_size || 100);
                // Max Spread is in CENTS (e.g. 4.5 = $0.045)
                const rawSpreadCtx = market.rewards?.max_spread !== undefined ? Number(market.rewards.max_spread) : undefined;
                const maxSpread = rawSpreadCtx !== undefined ? rawSpreadCtx / 100 : undefined;

                // CAPITAL AWARENESS CHECK
                // Cost to hold minShares of (YES + NO) = minShares * 1.0 (approx)
                const minCapitalRequired = minShares;

                if (minCapitalRequired > availableUSDC * 0.95) {
                    if (dailyRewards > 100 && processed <= 10) {
                        console.log(`[Capital Reject] ${market.question.slice(0, 40)} | MinCap: $${minCapitalRequired} > Balance: $${availableUSDC.toFixed(2)}`);
                    }
                    continue;
                }

                // CAPITAL EFFICIENCY SCORE (CES)
                const capitalEfficiencyScore = dailyRewards / minCapitalRequired;


                // 3. Fetch Orderbook & Metrics
                try {
                    // Use OFFICIAL getMidpoint API
                    const yesMid = await this.getMidpointFromAPI(yesTokenId);
                    const noMid = await this.getMidpointFromAPI(noTokenId);

                    if (yesMid === null) continue;

                    const mid = yesMid;
                    const orderbook = await this.getOrderBookCached(yesTokenId);

                    // Fallback for B/A if we need them, but API mid is truth
                    // We still need OB for competition check
                    if (!orderbook) continue;

                    // const { mid: obsMid, bestBid, bestAsk } = this.getMidPrice(orderbook) || { mid: 0.5, bestBid: 0, bestAsk: 1 };

                    // 1. Viability Check REMOVED (Polymarket rewards apply at any price, not just 0.50)
                    // const distFromMid = Math.abs(mid - 0.5);
                    // if (distFromMid > maxSpread) continue;

                    // Competition Heuristic
                    const competition = MarketUtils.estimateCompetition(orderbook, mid, maxSpread);

                    // Debug Competition Values (User Request)
                    /*if (processed <= 10) {
                        console.log(`[Debug] ${market.question.slice(0, 30)}... Competition: ${competition}, Rewards: ${dailyRewards.toFixed(2)}, MinShares: ${minShares}`);
                    }*/

                    // 4. Tiering Logic
                    // Use MARKET'S max_spread (in cents) for Tier classification as per user request
                    const marketMaxSpreadCents = maxSpread * 100;

                    let tier: 1 | 2 | 3 | null = null;

                    // T1: High Rewards, Tighter Spread req, High Comp OR High Capital Efficiency
                    // We prioritize Capital Efficiency for small wallets
                    const isT1 = (dailyRewards >= 200 || capitalEfficiencyScore >= 4.0) && (competition <= 5);
                    const isT2 = (dailyRewards >= 100 || capitalEfficiencyScore >= 2.0) && (competition <= 8);
                    const isT3 = (dailyRewards >= 25);

                    // Old MarketUtils calls removed in favor of Capital Efficiency Logic
                    // const isT1 = MarketUtils.isTier1...
                    // const isT2 = MarketUtils.isTier2...
                    // const isT3 = MarketUtils.isTier3...

                    let rejectionReason = "";
                    if (!isT1 && !isT2 && !isT3) {
                        if (dailyRewards < MarketUtils.getMinDailyRewards(3)) rejectionReason = `Low Rewards (${dailyRewards})`;
                        else if (marketMaxSpreadCents > REWARDS_CONFIG.TIER_3.MAX_SPREAD_CENTS) rejectionReason = `Loose Market Rules (${marketMaxSpreadCents.toFixed(1)}¢ > ${REWARDS_CONFIG.TIER_3.MAX_SPREAD_CENTS}¢)`;
                        else rejectionReason = "No Tier Criteria Met";
                    }

                    if (this.customFilter) {
                        tier = 1; // Force Custom Market
                        rejectionReason = "";
                    } else if (isT1) tier = 1;
                    else if (isT2) tier = 2;
                    else if (isT3) tier = 3;
                    else {
                        // Debug Rejection for High Reward Markets that fail T1
                        if (dailyRewards > 50 && processed <= 10) {
                            console.log(`[Rejection Debug] ${market.question.slice(0, 30)}... Reason: ${rejectionReason} | Rewards:${dailyRewards} Spread:${marketMaxSpreadCents.toFixed(1)}¢ Comp:${competition}`);
                        }
                    }

                    if (tier) {
                        // Scoring: Yield Score (Rewards / Competition)
                        const yieldScore = dailyRewards / (competition || 1);
                        const score = yieldScore;

                        // Add to candidates (Silent push, we log table at end)
                        // Construct Synthetic GammaMarket for compatibility
                        const syntheticGamma: GammaMarket = {
                            id: conditionId,
                            conditionId: conditionId,
                            question: market.question,
                            market_slug: market.market_slug || "",
                            end_date_iso: market.end_date_iso,
                            active: market.active,
                            clob_token_ids: [yesTokenId, noTokenId],
                            rewardsMinSize: minShares,
                            rewardsMaxSpread: maxSpread,
                            tickSize: Number(market.minimum_tick_size || 0.01),
                            negRisk: market.neg_risk,
                            clobRewards: [{
                                id: conditionId,
                                rewardsAmount: dailyRewards,
                                rewardsDailyRate: dailyRewards,
                            }]
                        };

                        if (minShares >= 200) {
                            console.warn(`[Debug Warning] Market ${market.question.slice(0, 20)} has shares ${minShares} >= 200, should be filtered by T1/T2 check!`);
                        }

                        const tickStr = String(market.minimum_tick_size || "0.01");
                        const tickSize = tickStr as TickSize;

                        // Delta Neutral Cost Calc
                        const yesMidOr = mid || 0.5;
                        const noMidOr = (1 - mid) || 0.5;
                        // FIX 2: Correct Min Capital Formula
                        // Account for price + 2% buffer + 2-sided cost
                        const minCapitalRequired = minShares * (yesMidOr + noMidOr) * 1.02;
                        const dnCost = Math.ceil(minShares * yesMidOr + minShares * noMidOr);


                        candidates.push({
                            marketId: conditionId,
                            gammaMarket: syntheticGamma,
                            tier,
                            score,
                            orders: [],
                            lastUpdate: Date.now(),
                            isFrozen: false,
                            yesTokenId,
                            noTokenId,
                            tickSize,
                            negRisk: market.neg_risk || false,
                            // Delta Neutral Cost Calc
                            dnCost,

                            yesPrice: mid,
                            noPrice: 1 - mid,
                            yesCost: Math.ceil(minShares * mid),
                            noCost: Math.ceil(minShares * (1 - mid)),
                            rewardsMinSize: minShares,
                            rewardsMaxSpread: maxSpread,
                            mode: "QUOTING",
                            inventory: { yes: 0, no: 0 },
                            minCapitalRequired,
                            capitalEfficiencyScore: score > 0 && minCapitalRequired > 0 ? (dailyRewards / minCapitalRequired) * 100 : 0,
                            dailyRewards,
                            competition
                        });
                    }
                } catch (err) {
                    console.error(`Error processing candidate ${conditionId}:`, err);
                }
            }

            console.log(`\nScan Complete. Found ${candidates.length} candidates.`);

            // Print Candidate Table
            console.log("MARKET CANDIDATES TABLE:");
            console.log(
                "Tier".padEnd(6) +
                "Score".padEnd(8) +
                "Rewards".padEnd(9) +
                "Comp".padEnd(6) +
                "Shares".padEnd(8) +
                "Spread".padEnd(8) +
                "YesPx".padEnd(7) +
                "NoPx".padEnd(7) +
                "YCost".padEnd(8) +
                "NCost".padEnd(8) +
                "TotCost".padEnd(9) +
                "Question"
            );
            console.log("-".repeat(140));

            // Temporary sort for display clarity (by Score Desc)
            const displayList = [...candidates].sort((a, b) => b.score - a.score);

            for (const c of displayList) {
                // Determine Comp from Metrics (reverse eng or store it? we didn't store comp directly in state, but we can calc or just infer)
                // Actually we stored Score = Rewards/Comp. So Comp = Rewards/Score.
                const r = c.gammaMarket.clobRewards?.[0]?.rewardsDailyRate || 0;
                const compVal = c.score > 0 ? Math.round(r / c.score) : 0;

                const cost = c.dnCost || c.rewardsMinSize;
                const yp = c.yesPrice?.toFixed(2) || "0.00";
                const np = c.noPrice?.toFixed(2) || "0.00";
                const yc = c.yesCost || 0;
                const nc = c.noCost || 0;

                console.log(
                    `T${c.tier}`.padEnd(6) +
                    c.score.toFixed(1).padEnd(8) +
                    `$${r}`.padEnd(9) +
                    `${compVal}`.padEnd(6) +
                    `${c.rewardsMinSize}`.padEnd(8) +
                    `${(c.rewardsMaxSpread * 100).toFixed(1)}¢`.padEnd(8) +
                    `${yp}`.padEnd(7) +
                    `${np}`.padEnd(7) +
                    `$${yc}`.padEnd(8) +
                    `$${nc}`.padEnd(8) +
                    `$${cost}`.padEnd(9) +
                    c.gammaMarket.question.slice(0, 40)
                );
            }
            console.log("-".repeat(100));

            // Clear expired blacklist entries
            const now = Date.now();
            for (const [id, expiry] of this.blacklist.entries()) {
                if (now > expiry) this.blacklist.delete(id);
            }

            // STRICT USER REQUIREMENT: "Only selected Tier 1 markets will be used"
            // Filter first, then Sort.
            const validCandidates = candidates.filter(c => {
                // We now accept T1 and T2 for diversification if T1 is too expensive/empty
                if (c.tier > 2) return false;
                if (this.blacklist.has(c.marketId)) return false;
                return true;
            });
            console.log(`Filtered to ${validCandidates.length} Valid Candidates (Tier 1 & 2).`);

            // BONUS: Detect Small Wallet Gems
            validCandidates.forEach(c => {
                // minShares 20-50, Rewards >= 100, Competition <= 3
                const dr = c.dailyRewards || 0;
                const comp = c.competition || 99;
                const isGem = c.rewardsMinSize >= 20 && c.rewardsMinSize <= 50 && dr >= 100 && comp <= 3;
                if (isGem) {
                    // Force high efficiency score to prioritize
                    c.capitalEfficiencyScore = (c.capitalEfficiencyScore || 0) * 2.0;
                    // console.log(`[GEM] Found Small Wallet Gem: ${c.gammaMarket.question.slice(0,30)}`);
                }
            });



            // FIX 1: Hard Cap Active Markets by effectiveMinCap (1.05x buffer)
            const availableForTrading = Number((await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })).balance) / 1e6; // Refresh balance

            // Phase 17 Issue #1: Wallet-Aware Selection (Pre-filter poison markets)
            // Adjusted: <$100 -> 50, <$200 -> 100, else 200
            const MAX_ACCEPTABLE_MIN_SHARES = availableForTrading < 100 ? 50 : (availableForTrading < 200 ? 100 : 200);

            // Filter out markets too large for this wallet
            const walletAdjustedCandidates = validCandidates.filter(c => {
                if (c.rewardsMinSize > MAX_ACCEPTABLE_MIN_SHARES) return false;
                return true;
            });

            let globalMaxCapReq = 0;

            walletAdjustedCandidates.forEach(c => {
                // Phase 17 Issue #2: Robust Capital Calculation (Worst-Case Edge)
                // Use max spread to find worst-case execution price (Pessimistic Affordability)
                const maxSpread = Math.min((REWARDS_CONFIG.TIER_1.MAX_SPREAD_CENTS / 100) || 0.10, 0.10); // Cap at 10 cents
                const worstYes = Math.min((c.yesPrice ?? 0.5) + maxSpread, 0.999);
                const worstNo = Math.min((c.noPrice ?? 0.5) + maxSpread, 0.999);

                const effectiveMinCap = c.rewardsMinSize * (worstYes + worstNo) * 1.05; // 5% buffer on top of worst case
                c.minCapitalRequired = effectiveMinCap;
                if (effectiveMinCap > globalMaxCapReq) globalMaxCapReq = effectiveMinCap;
            });

            // FIX 1: Unified Capital-Consuming Selection Loop
            // Sort by CES (Small Wallet Gems are already boosted 2x in validCandidates loop)
            const sortedByCES = [...walletAdjustedCandidates].sort((a, b) => (b.capitalEfficiencyScore || 0) - (a.capitalEfficiencyScore || 0));

            const selectedMarkets: MarketState[] = [];
            // Use fresh availableForTrading derived above
            let remainingBalance = availableForTrading;

            const ABSOLUTE_MAX_MARKETS = REWARDS_CONFIG.ALLOCATION.MAX_ACTIVE_MARKETS || 5;

            for (const m of sortedByCES) {
                // HARD invariant: must afford full two-sided minShares (already calc'd in c.minCapitalRequired with 1.05 boost)
                const cap = m.minCapitalRequired || Infinity;

                if (remainingBalance >= cap) {
                    (m as any)._reservedCapital = cap;
                    selectedMarkets.push(m);
                    remainingBalance -= cap;
                } else {
                    // Stop immediately if we can't afford the next best market.
                    // Do NOT skip to smaller ones, as that fragments capital on lower quality markets.
                    break;
                }

                if (selectedMarkets.length >= ABSOLUTE_MAX_MARKETS) {
                    break;
                }
            }

            console.log(`[Capital Routing] Balance: $${availableUSDC.toFixed(2)} | Selected: ${selectedMarkets.length} | Remaining: $${remainingBalance.toFixed(2)}`);
            selectedMarkets.forEach(m => console.log(`  -> Picked: ${m.gammaMarket.question.slice(0, 30)}... (CES: ${m.capitalEfficiencyScore?.toFixed(1)}, MinCap: $${m.minCapitalRequired})`));

            const topMarkets = selectedMarkets;


            // Update active markets with STATE MERGING
            const newActiveMarkets = new Map<string, MarketState>();

            for (const m of topMarkets) {
                if (this.activeMarkets.has(m.marketId)) {
                    const oldState = this.activeMarkets.get(m.marketId)!;
                    // Preserve order state & managing mode
                    m.orders = oldState.orders;
                    m.mode = oldState.mode;
                    m.inventory = oldState.inventory;
                    m.lastFillTime = oldState.lastFillTime;
                    newActiveMarkets.set(m.marketId, m);
                } else {
                    console.log(`Adding new market: ${m.gammaMarket.question} (Tier ${m.tier}, Rewards ${MarketUtils.extractDailyRewards(m.gammaMarket).toFixed(2)})`);
                    newActiveMarkets.set(m.marketId, m);
                }
            }

            // Phase 21: Cancel orders for dropped - BUT PROTECT MARKETS WITH INVENTORY
            for (const [id, state] of this.activeMarkets.entries()) {
                if (!newActiveMarkets.has(id)) {
                    // CRITICAL: Don't rotate out if we have inventory to manage
                    const hasInventory = (state.inventory?.yes || 0) > 0.1 || (state.inventory?.no || 0) > 0.1;
                    const isManaging = state.mode === "MANAGING";

                    if (hasInventory || isManaging) {
                        console.log(`[PROTECTED] Keeping ${state.gammaMarket.question.slice(0, 40)} - has inventory (YES: ${state.inventory?.yes?.toFixed(2) || 0}, NO: ${state.inventory?.no?.toFixed(2) || 0})`);
                        newActiveMarkets.set(id, state);  // Keep it in active markets
                        continue;
                    }

                    console.log(`Rotating out market: ${state.gammaMarket.question}`);
                    await this.cancelMarketOrders(state);
                }
            }

            this.activeMarkets = newActiveMarkets;

        } catch (e) {
            console.error("Scan and Rotate failed:", e);
        }
    }

    private async cancelMarketOrders(state: MarketState) {
        if (state.orders.length > 0) {
            try {
                await this.clobClient.cancelOrders(state.orders.map(o => o.orderId));
                state.orders = [];
            } catch (e) {
                // ignore
            }
        }
    }

    private getMidPrice(orderbook: any): { mid: number, bestBid: number, bestAsk: number } | null {
        if (!orderbook || !orderbook.bids || orderbook.bids.length === 0 || !orderbook.asks || orderbook.asks.length === 0) return null;
        const bestBid = Number(orderbook.bids[0].price);
        const bestAsk = Number(orderbook.asks[0].price);
        return { mid: (bestBid + bestAsk) / 2, bestBid, bestAsk };
    }

    // --- Helpers ---
    private roundToTick(price: number, tickSize: number): number {
        return Math.round(price / tickSize) * tickSize;
    }

    // --- Fill Avoidance ---
    private async runFillAvoidance(targetState?: MarketState) {
        const loopTargets = targetState ? [targetState] : Array.from(this.activeMarkets.values());

        for (const state of loopTargets) {
            const id = state.marketId;
            if (state.isFrozen) continue;

            try {
                // 1. Fetch Official Midpoints (API) - MATCHES PLACE LOGIC
                // We use Promise.all for parallelism
                const [yesMidVal, noMidVal] = await Promise.all([
                    this.getMidpointFromAPI(state.yesTokenId),
                    this.getMidpointFromAPI(state.noTokenId)
                ]);

                if (yesMidVal === null || noMidVal === null) continue;

                let triggered = false;

                // Phase 4: Volatility Tracking & Freezing
                this.updatePriceHistory(id, yesMidVal);
                const volatility = this.calculateVolatility(id);
                const maxSpread = state.rewardsMaxSpread || 0.1;
                const freezeThreshold = maxSpread * REWARDS_CONFIG.RISK_MANAGEMENT.VOLATILITY_SENSITIVITY;

                if (volatility > freezeThreshold) {
                    this.logAction(state.gammaMarket.question, "FREEZE", -1, -1, -1, `High Volatility: ${volatility.toFixed(4)} > ${freezeThreshold.toFixed(4)}. Freezing market.`);
                    state.isFrozen = true;
                    triggered = true;
                }

                // 2. Fetch Official Spread (API) - SPREAD COMPRESSION CHECK
                let currentSpread = 0.01;
                try {
                    const s = await this.clobClient.getSpread(state.yesTokenId);
                    currentSpread = Number(s.spread);
                } catch (e) {
                    // console.warn("Failed to get spread for avoidance", e);
                }

                const distThresholdBase = state.dynamicStoploss !== undefined
                    ? state.dynamicStoploss
                    : (this.customAvoid !== undefined ? this.customAvoid : REWARDS_CONFIG.FILL_AVOIDANCE.MIN_DISTANCE_TO_MID);

                // Phase 4: Adaptive Distance (Predictive Cancel)
                // If volatility is significant, expand cancellation distance to be safer
                let distThreshold = distThresholdBase;
                if (volatility > (freezeThreshold * 0.5)) { // Start expanding at 50% of freeze
                    const volMultiplier = 1 + (volatility / freezeThreshold); // Up to 2x distance
                    distThreshold = distThresholdBase * volMultiplier;
                    // this.logAction(state.gammaMarket.question, "ADAPT", -1, -1, distThreshold, `Expanded threshold due to vol: ${volatility.toFixed(4)}`);
                }

                // Phase 5: Temporal Alpha (Tighter stoploss during low activity)
                const temporalMult = this.getCurrentRiskMultiplier();
                if (temporalMult !== 1.0) {
                    distThreshold = distThreshold / temporalMult;
                }

                // CHECK 1: GLOBAL SPREAD TOO TIGHT?
                // User Rule: "cancel all limits if gap gets less than 0.2c either side" (Implies tight compressed market)
                // We use a safe floor. If spread drops below our STOPLOSS (or 0.2c default), we are in danger.
                // CHECK 1: GLOBAL SPREAD TOO TIGHT? - REMOVED (User only wants distance check)
                // if (currentSpread < distThreshold) { ... }

                // CHECK 2: INDIVIDUAL ORDERS TOO CLOSE? (Phase 16 Split Drift)
                if (!triggered) {
                    for (const order of state.orders) {
                        const mid = order.tokenId === state.yesTokenId ? yesMidVal : noMidVal;
                        const dist = Math.abs(order.price - mid);

                        // Phase 16: Temporal Persistence
                        const age = Date.now() - (order.placedAt || 0);
                        const softLimit = distThreshold;

                        // Phase 17 Issue #4: Absolute Drift Floor (Prevent sub-tick cancels in calm markets)
                        const tickVal = Number(state.tickSize) || 0.01;
                        const absoluteFloor = tickVal * 2;
                        // Use MAX of (AbsoluteFloor, RelativeTight)
                        const hardLimit = Math.max(absoluteFloor, distThreshold * 0.15);

                        if (dist <= hardLimit) {
                            this.logAction(state.gammaMarket.question, "DRIFT", -1, -1, hardLimit, `HARD DRIFT: ${order.price} vs ${mid.toFixed(4)}. Dist ${dist.toFixed(4)}`);
                            triggered = true;
                            break; // Emergency Kill
                        }

                        if (dist <= softLimit) {
                            // Soft Drift - Check Grace Period
                            if (age > REWARDS_CONFIG.FILL_AVOIDANCE.MIN_QUOTE_LIFETIME_MS) {
                                this.logAction(state.gammaMarket.question, "DRIFT", -1, -1, softLimit, `SOFT DRIFT (Expired Grace): ${order.price} vs ${mid.toFixed(4)}. Age ${age}ms`);
                                triggered = true;
                                break;
                            } else {
                                // Grace Period - Do NOT cancel
                                // Log occasionally?
                                if (Math.random() < 0.05) {
                                    // console.log(`[Rewards] Soft Drift Grace for ${state.gammaMarket.question.slice(0, 20)}: Dist ${dist.toFixed(4)} < ${softLimit.toFixed(4)} but Age ${age}ms < 30s`);
                                }
                            }
                        }
                    }
                }

                if (triggered) {
                    // Cancel ALL orders for this market to be safe (User rule: "close both sides completely")
                    const allIds = state.orders.map(o => o.orderId);
                    if (allIds.length > 0) {
                        await this.clobClient.cancelOrders(allIds);
                        state.orders = []; // Clear local state
                        this.logAction(state.gammaMarket.question, "CANCEL", -1, -1, -1, `Cancelled ${allIds.length} orders safely.`);
                    }
                }



                const end = new Date(state.gammaMarket.end_date_iso || state.gammaMarket.endDate || "");
                if ((end.getTime() - Date.now()) < 24 * 60 * 60 * 1000) {
                    console.warn("Market entering last 24h. Freezing.");
                    state.isFrozen = true;
                    await this.cancelMarketOrders(state);
                }

            } catch (e) {
                console.error(`Fill avoidance check failed for ${id}:`, e);
            }
        }
    }

    // --- Order Management ---

    private async manageMarketOrders(state: MarketState) {
        if (state.orders.length > 0) return;

        try {
            // 0. Check Balance & Allowance First
            let availableUSDC = 0;
            try {
                // Fetch COLLATERAL (USDC) Balance & Allowance
                // Note: getBalanceAllowance returns TOTAL balance, including locked funds in open orders
                const balRes = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });

                // Check available funds
                if (parseFloat(balRes.balance) < 5) { // Minimum $5 safety
                    this.logAction(state.gammaMarket.question, "LOW FUNDS", -1, -1, -1, `Balance ${balRes.balance} too low. Pausing 2m.`);
                    this.lowBalancePauseUntil = Date.now() + 120000;
                    return;
                }

                // Calculate available for trading 
                // We'll use a simplified check: Total Balance - Locked. 
                // Note: The API response 'balance' is total collateral. 'allowances' are just approvals.
                // We can't easily see "locked in open orders" without tracking it ourselves or querying open orders.
                // For now, we trust the "Insufficient funds" check later or just use raw balance.

                availableUSDC = parseFloat(balRes.balance) / 1e6; // Convert from wei to USDC

                // Phase 3: Fair Budget Allocation

                // FIX 3: Prioritize Reserved Capital
                let budgetPerMarket = (state as any)._reservedCapital;

                if (!budgetPerMarket) {
                    // Fallback for legacy/error cases (though scan should set it)
                    const activeCount = this.activeMarkets.size || 1;
                    const totalTargetBudget = availableUSDC * REWARDS_CONFIG.ALLOCATION.MAX_DEPLOYED_PERCENT;
                    budgetPerMarket = totalTargetBudget / activeCount;
                    // Clamp by global max budget per market
                    budgetPerMarket = Math.min(budgetPerMarket, REWARDS_CONFIG.ALLOCATION.MAX_BUDGET_PER_MARKET);
                }

                console.log(`[Balance] Total: $${availableUSDC.toFixed(2)}, Budget/Mkt: $${budgetPerMarket.toFixed(2)}, Required: ~$${(state.rewardsMinSize * 0.5).toFixed(2)}`);

                if (budgetPerMarket < 5) {
                    this.logAction(state.gammaMarket.question, "SKIP", -1, -1, -1, `Budget per market $${budgetPerMarket.toFixed(2)} too low.`);
                    return;
                }

                // FIX 2: Hard-Gate Budget against MinCapitalRequired
                const minCapital = state.minCapitalRequired || (state.rewardsMinSize * ((state.yesCost || 0.5) + (state.noCost || 0.5)));
                if (budgetPerMarket < minCapital) {
                    this.logAction(state.gammaMarket.question, "SKIP", -1, -1, -1, `Budget $${budgetPerMarket.toFixed(2)} < MinCapital $${minCapital.toFixed(2)}. Cannot meet minShares.`);
                    return;
                }

                // Store the effective budget for sizing later
                // @ts-ignore
                state._effectiveBudget = budgetPerMarket;
            } catch (e) {
                console.warn("Failed to fetch balance, assuming 0 to be safe:", e);
                return;
            }

            const ordersToPost: any[] = [];
            // Arrays for tracking
            const signedOrders: any[] = [];
            const validOrders: any[] = [];

            // 1. Fetch Orderbooks
            const yesOb = await this.getOrderBookCached(state.yesTokenId);
            const noOb = await this.getOrderBookCached(state.noTokenId);

            if (!yesOb || !noOb) return;

            // FIX 4: Use Live Midpoint for Pressure Analysis (Prevent Stale Data)
            let yesMidLive = 0.5;
            let noMidLive = 0.5;
            try {
                yesMidLive = await this.getMidpointFromAPI(state.yesTokenId);
                noMidLive = await this.getMidpointFromAPI(state.noTokenId);
            } catch (e) {
                // Warning logged inside getMidpoint
            }

            // REWARD OPTIMIZATION: Ladder Strategy vs Single Spread
            let useLadder = REWARDS_CONFIG.REWARD_OPTIMIZATION.USE_LADDER && this.customSpread === undefined;
            const useAsymmetric = REWARDS_CONFIG.REWARD_OPTIMIZATION.USE_ASYMMETRIC && this.customSpread === undefined;

            let ladderLevels: Array<{ distance: number; sizePercent: number }> = [];
            let targetAvoid = this.customAvoid !== undefined ? this.customAvoid : REWARDS_CONFIG.FILL_AVOIDANCE.MIN_DISTANCE_TO_MID;

            // FIX 4: Correct Ladder Eligibility Check (MinShares * Levels)
            if (useLadder) {
                // Determine levels first to know count
                // Assume standard allocation (70/30) if not defined or dynamic
                const levelCount = 2; // Default 2 levels for estimate
                const requiredSharesForLadder = state.rewardsMinSize * levelCount;

                // Check if budget can support MIN SHARES per level
                // We use _effectiveBudget to check affordability
                const costPerShare = (state.yesCost || 0.5) + (state.noCost || 0.5);
                const affordableShares = (state as any)._effectiveBudget / costPerShare;

                if (affordableShares < requiredSharesForLadder) {
                    useLadder = false;
                    // this.logAction(state.gammaMarket.question, "LADDER_OFF", -1, -1, -1, `Budget supports ${Math.floor(affordableShares)} shares < Required ${requiredSharesForLadder}. Single Order.`);
                }
            }

            // Phase 8: Liquidity Pressure Detection & Hysteresis
            // Initialize if null
            if (!state.pressureState) {
                state.pressureState = {
                    yesDistance: 0.005,
                    noDistance: 0.005,
                    yesExhaustionCycles: 0,
                    noExhaustionCycles: 0
                };
            }

            // Analyze Depth Bands
            const yesDepth = analyzeDepthBands(yesOb, yesMidLive).bids;
            const noDepth = analyzeDepthBands(noOb, noMidLive).bids;

            const LP_CONFIG = REWARDS_CONFIG.LIQUIDITY_PRESSURE;

            if (LP_CONFIG.ENABLE_DYNAMIC_DISTANCING) {
                // Phase 19: Calculate Trade Velocity (USDC/sec)
                // Initialize trade velocity tracking if missing
                if (!state.tradeVelocity) {
                    state.tradeVelocity = {
                        recentTrades: [],
                        usdcPerSecond: LP_CONFIG.MIN_TRADE_RATE_EPSILON || 0.1,
                        lastUpdate: Date.now()
                    };
                }

                // Update trade velocity from recent public trades
                // Note: Public trades would be tracked via WebSocket in production
                // For now, use a conservative fallback
                const now = Date.now();
                const windowMs = LP_CONFIG.TRADE_VELOCITY_WINDOW_MS || 30000;

                // Filter trades within window
                state.tradeVelocity.recentTrades = state.tradeVelocity.recentTrades.filter(
                    t => now - t.timestamp < windowMs
                );

                // Calculate USDC/sec
                const totalValue = state.tradeVelocity.recentTrades.reduce((sum, t) => sum + t.value, 0);
                const tradeRateUSDC = totalValue > 0
                    ? totalValue / (windowMs / 1000)
                    : (LP_CONFIG.MIN_TRADE_RATE_EPSILON || 0.1); // Fallback for zero trades (very safe)

                state.tradeVelocity.usdcPerSecond = tradeRateUSDC;
                state.tradeVelocity.lastUpdate = now;

                // Phase 20: Calculate Current Spread from Orderbook
                const yesBestBid = yesOb.bids[0]?.price || yesMidLive;
                const yesBestAsk = yesOb.asks[0]?.price || yesMidLive;
                const yesSpread = Math.abs(yesBestAsk - yesBestBid);

                const noBestBid = noOb.bids[0]?.price || noMidLive;
                const noBestAsk = noOb.asks[0]?.price || noMidLive;
                const noSpread = Math.abs(noBestAsk - noBestBid);

                // Helper for Hysteresis Logic with TTC Model + Spread-Relative Distances
                const updatePressureState = (
                    currentDepth: DepthBands,
                    currentDist: number,
                    cycles: number,
                    currentSpread: number,
                    lastDepth1?: number,
                    lastDepthTs?: number
                ): { dist: number, cycles: number, lastDepth1: number, lastDepthTs: number } => {
                    // Phase 20: Calculate spread-relative distances with safety bounds
                    const MIN = LP_CONFIG.MIN_DISTANCE_CENTS || 0.002;
                    const MAX = Math.min(
                        LP_CONFIG.MAX_DISTANCE_CENTS || 0.015,
                        state.rewardsMaxSpread || 0.05
                    );

                    const aggressiveDist = Math.max(MIN, Math.min(currentSpread * (LP_CONFIG.SPREAD_MULTIPLIERS?.AGGRESSIVE || 1.0), MAX));
                    const moderateDist = Math.max(MIN, Math.min(currentSpread * (LP_CONFIG.SPREAD_MULTIPLIERS?.MODERATE || 1.5), MAX));
                    const defensiveDist = Math.max(MIN, Math.min(currentSpread * (LP_CONFIG.SPREAD_MULTIPLIERS?.DEFENSIVE || 2.0), MAX));

                    let targetDist = aggressiveDist;

                    // Phase 18: Replenishment Logic
                    const now = Date.now();
                    let isReplenishingFast = false;

                    if (lastDepth1 !== undefined && lastDepthTs !== undefined) {
                        const deltaDepth = currentDepth.layer1 - lastDepth1;
                        const deltaTimeSeciles = (now - lastDepthTs) / 1000;
                        if (deltaTimeSeciles > 0) {
                            const rate = deltaDepth / deltaTimeSeciles;
                            if (rate > (LP_CONFIG.REPLENISH_THRESHOLD_USDC_PER_SEC || 99999)) {
                                isReplenishingFast = true;
                                // console.log(`[Replenish] Firing! Rate $${rate.toFixed(0)}/s > Threshold`);
                            }
                        }
                    }

                    // Phase 19: Time-to-Consume (TTC) Model
                    // Calculate TTC for each depth band
                    const TTC_0_5c = currentDepth.layer1 / tradeRateUSDC;
                    const TTC_1_0c = currentDepth.layer2 / tradeRateUSDC;
                    const TTC_1_5c = currentDepth.layer3 / tradeRateUSDC;

                    // Apply refill rate to effective TTC (Phase 18 enhancement)
                    let effectiveTTC_0_5c = TTC_0_5c;
                    if (isReplenishingFast && lastDepth1 !== undefined && lastDepthTs !== undefined) {
                        const refillRate = (currentDepth.layer1 - lastDepth1) / ((now - lastDepthTs) / 1000);
                        const horizon = LP_CONFIG.TTC_SAFETY_HORIZONS.AGGRESSIVE;
                        const effectiveDepth = currentDepth.layer1 + refillRate * horizon;
                        effectiveTTC_0_5c = effectiveDepth / tradeRateUSDC;
                    }

                    // Select distance based on TTC safety horizons (Phase 20: now spread-relative)
                    if (effectiveTTC_0_5c >= LP_CONFIG.TTC_SAFETY_HORIZONS.AGGRESSIVE) {
                        targetDist = aggressiveDist; // Spread-relative aggressive
                    } else if (TTC_1_0c >= LP_CONFIG.TTC_SAFETY_HORIZONS.MODERATE) {
                        targetDist = moderateDist; // Spread-relative moderate
                    } else {
                        targetDist = defensiveDist; // Spread-relative defensive
                    }

                    // Apply Hysteresis: Only change if condition persists
                    // If target differs from current, increment counter
                    let nextCycles = cycles;
                    let nextDist = currentDist;

                    if (targetDist !== currentDist) {
                        if (cycles + 1 >= LP_CONFIG.HYSTERESIS_CYCLES) {
                            nextDist = targetDist;
                            nextCycles = 0; // Change & Reset
                        } else {
                            nextCycles = cycles + 1; // Wait
                        }
                    } else {
                        nextCycles = 0; // Reset if stable
                    }

                    return { dist: nextDist, cycles: nextCycles, lastDepth1: currentDepth.layer1, lastDepthTs: now };
                };

                const yesUpdate = updatePressureState(yesDepth, state.pressureState.yesDistance, state.pressureState.yesExhaustionCycles, yesSpread, state.pressureState.yesLastDepth1, state.pressureState.yesLastDepthTs);
                state.pressureState.yesDistance = yesUpdate.dist;
                state.pressureState.yesExhaustionCycles = yesUpdate.cycles;
                state.pressureState.yesLastDepth1 = yesUpdate.lastDepth1;
                state.pressureState.yesLastDepthTs = yesUpdate.lastDepthTs;

                const noUpdate = updatePressureState(noDepth, state.pressureState.noDistance, state.pressureState.noExhaustionCycles, noSpread, state.pressureState.noLastDepth1, state.pressureState.noLastDepthTs);
                state.pressureState.noDistance = noUpdate.dist;
                state.pressureState.noExhaustionCycles = noUpdate.cycles;
                state.pressureState.noLastDepth1 = noUpdate.lastDepth1;
                state.pressureState.noLastDepthTs = noUpdate.lastDepthTs;

                // Log Significant Moves (Retreats) with TTC info
                if (yesUpdate.cycles === 0 && yesUpdate.dist > 0.005 && yesUpdate.dist > state.pressureState.yesDistance) {
                    const yesTTC = yesDepth.layer1 / tradeRateUSDC;
                    this.logAction(state.gammaMarket.question, "PRESSURE", -1, -1, yesUpdate.dist,
                        `YES TTC ${yesTTC.toFixed(0)}s (Depth $${yesDepth.layer1.toFixed(0)} / Rate $${tradeRateUSDC.toFixed(1)}/s). Retreating to ${yesUpdate.dist * 100}¢`);
                }
            }


            if (useLadder) {
                // Use reward-density ladder
                ladderLevels = REWARDS_CONFIG.REWARD_OPTIMIZATION.LADDER_LEVELS;

                // Calculate expected scores for logging
                if (state.rewardsMaxSpread) {
                    const scores = ScoringCalc.compareLadderLevels(
                        ladderLevels.map(l => ({ distance: l.distance, size: state.rewardsMinSize * l.sizePercent })),
                        state.rewardsMaxSpread
                    );
                    const totalScore = scores.reduce((sum, s) => sum + s.score, 0);
                    const avgEfficiency = scores.reduce((sum, s) => sum + s.efficiency, 0) / scores.length;

                    this.logAction(state.gammaMarket.question, "LADDER", -1, -1, -1,
                        `Levels: ${ladderLevels.length}, Score: ${totalScore.toFixed(1)}, Eff: ${(avgEfficiency * 100).toFixed(0)}%`);
                }

                // Set dynamic stoploss to tightest ladder level
                targetAvoid = Math.min(...ladderLevels.map(l => l.distance)) * 0.5;
                state.dynamicStoploss = targetAvoid;

            } else {
                // Legacy single-spread logic
                let targetOffset = this.customSpread !== undefined ? this.customSpread : 0.01;

                if (this.customSpread === undefined) {
                    // Get current spread
                    let currentSpread = 0.01;
                    try {
                        const spreadRes = await this.clobClient.getSpread(state.yesTokenId);
                        currentSpread = Number(spreadRes.spread);
                        if (currentSpread <= 0.000001) {
                            const bestAsk = Number(yesOb.asks[0]?.price || 1);
                            const bestBid = Number(yesOb.bids[0]?.price || 0);
                            currentSpread = bestAsk - bestBid;
                        }
                    } catch (e) {
                        const bestAsk = Number(yesOb.asks[0]?.price || 1);
                        const bestBid = Number(yesOb.bids[0]?.price || 0);
                        currentSpread = bestAsk - bestBid;
                    }

                    if (currentSpread < 0) currentSpread = 0.01;
                    if (currentSpread > 0.99) currentSpread = 0.05;

                    targetOffset = currentSpread * 2;

                    if (state.rewardsMaxSpread !== undefined) {
                        const maxAllowable = state.rewardsMaxSpread / 2;
                        if (targetOffset > maxAllowable) targetOffset = maxAllowable;
                    }
                    const minTick = Number(state.tickSize) || 0.01;
                    if (targetOffset < minTick) targetOffset = minTick;

                    this.logAction(state.gammaMarket.question, "REQUOTE", currentSpread, targetOffset, -1,
                        `Max: ${state.rewardsMaxSpread ? state.rewardsMaxSpread.toFixed(3) : "None"}`);
                }

                // Convert single offset to ladder format for unified processing
                ladderLevels = [{ distance: targetOffset, sizePercent: 1.0 }];

                if (this.customAvoid === undefined) {
                    targetAvoid = targetOffset * 0.5;
                    state.dynamicStoploss = targetAvoid;
                    this.logAction(state.gammaMarket.question, "CONFIG", -1, -1, targetAvoid,
                        `Dynamic Stoploss: ${targetAvoid.toFixed(4)}`);
                } else {
                    state.dynamicStoploss = undefined;
                }
            }




            // Get OFFICIAL midpoints
            const yesMid = await this.getMidpointFromAPI(state.yesTokenId);
            const noMid = await this.getMidpointFromAPI(state.noTokenId);

            if (yesMid === null) {
                // console.log(`[Debug] No Mid Data for ${state.gammaMarket.question.slice(0, 20)}`);
                return;
            }

            // Phase 16: Midpoint Tolerance
            const currentMid = yesMid ?? 0.5;
            if (state.lastQuotedMid !== undefined && state.orders.length > 0) {
                const diff = Math.abs(currentMid - state.lastQuotedMid);
                const tolerance = (Number(state.tickSize) || 0.01) * (REWARDS_CONFIG.REWARD_OPTIMIZATION.MID_TOLERANCE_TICKS || 2);
                if (diff <= tolerance) {
                    // Mid hasn't moved enough, prevent churn
                    return;
                }
            }
            state.lastQuotedMid = currentMid;


            const tickNum = Number(state.tickSize);

            // Validate Prices
            const isValidPrice = (p: number) => p > 0.001 && p < 0.999;

            // Two-Sided Requirement: If <0.10 or >0.90, MUST quote both sides
            const needsTwoSided = yesMid < 0.10 || yesMid > 0.90;

            // FIX 2: Enforce Two-Sided BUY Affordability Early
            const minCostTwoSided = state.rewardsMinSize * ((yesMid ?? 0.5) + (noMid ?? 0.5)) * 1.01;
            // @ts-ignore
            if ((state._effectiveBudget || 0) < minCostTwoSided) {
                // this.logAction(state.gammaMarket.question, "SKIP", -1, -1, -1, `Cannot afford two-sided minShares ($${minCostTwoSided.toFixed(2)})`);
                return;
            }

            // Budget / Sizing
            let rawSize = Math.max(state.rewardsMinSize, 20); // Min 20 shares to be safe

            // Phase 4: Adaptive Scaling (Priority to high-reward markets)
            const dailyRewards = state.gammaMarket.clobRewards?.[0]?.rewardsDailyRate || 0;
            const adaptiveMultiplier = Math.sqrt(dailyRewards / REWARDS_CONFIG.RISK_MANAGEMENT.ADAPTIVE_SIZING_BASELINE_REWARDS);
            rawSize = Math.round(rawSize * Math.max(adaptiveMultiplier, 0.5)); // Min 0.5x scaling

            // Phase 5: Temporal Alpha (Time-based risk)
            const temporalMultiplier = this.getCurrentRiskMultiplier();
            if (temporalMultiplier !== 1.0) {
                rawSize = Math.round(rawSize * temporalMultiplier);
            }

            // Phase 3: Budget-Based Capping
            // @ts-ignore
            const mktBudget = state._effectiveBudget || 20;

            // FIX 3: Correct Budget Capping (Cost per Share)
            // Use actual mid prices + 1% buffer
            const costPerShare = (yesMid ?? 0.5) + (noMid ?? 0.5);
            /* const budgetAdjustedSize = Math.floor(mktBudget / (costPerShare * 1.01)); */ // Moved down

            // Phase 17 Issue #3: Early Ladder Locking (Invariant Enforcement)
            // Check if we can afford the FULL ladder structure at MINIMUM sizes
            if (useLadder) {
                const maxAffordableShares = Math.floor(mktBudget / (costPerShare * 1.01));
                const maxLevelSizePercent = Math.max(...ladderLevels.map(l => l.sizePercent));
                // Inverse: If we have maxAffordableQuotes, is it enough to satisfy minShares for the largest rung?
                // rawSize * pct >= minShares  => rawSize >= minShares / pct
                const minRawSizeRequiredForLadder = Math.ceil(state.rewardsMinSize / maxLevelSizePercent);

                if (maxAffordableShares < minRawSizeRequiredForLadder) {
                    // We cannot afford a multi-rung ladder while respecting minShares validly.
                    // Collapse to single defensive order immediately.
                    ladderLevels = [{ distance: ladderLevels[0].distance, sizePercent: 1.0 }];
                    // console.log(`[Ladder] Early Collapse: Budget ${mktBudget} allows ${maxAffordableShares} shares < LadderReq ${minRawSizeRequiredForLadder}`);
                }
            }

            // Recalculate size limit based on budget (standard)
            const budgetAdjustedSize = Math.floor(mktBudget / (costPerShare * 1.01));

            if (rawSize > budgetAdjustedSize) {
                // this.logAction(state.gammaMarket.question, "BUDGET", -1, -1, -1, `Capping size ${rawSize} -> ${budgetAdjustedSize} ($${mktBudget.toFixed(0)})`);
                rawSize = budgetAdjustedSize;
            }

            // PHASE 2: Dynamic Allocation (Internal Capital Reuse)
            // Concentrates capital in high-yield T1 markets
            if (state.score > REWARDS_CONFIG.CAPITAL_EFFICIENCY.CONCENTRATION_THRESHOLD) {
                const multiplier = 1 + (state.score - REWARDS_CONFIG.CAPITAL_EFFICIENCY.CONCENTRATION_THRESHOLD) / 25;
                const oldSize = rawSize;
                rawSize = Math.round(rawSize * Math.min(multiplier, REWARDS_CONFIG.CAPITAL_EFFICIENCY.MAX_CAPITAL_CONCENTRATION));
                if (rawSize !== oldSize) {
                    this.logAction(state.gammaMarket.question, "SCALE", -1, -1, -1, `Concentrating capital: ${rawSize} shares (Score: ${state.score.toFixed(1)})`);
                }
            }

            // FIX 1: Hard Floor after ALL scaling
            if (rawSize < state.rewardsMinSize) {
                this.logAction(state.gammaMarket.question, "SKIP", -1, -1, -1, `Final size ${rawSize} < minShares ${state.rewardsMinSize}`);
                return;
            }

            // Phase 3: Global Reward Monitor (Log aggregat stats)
            const now = Date.now();
            if (now - this.lastGlobalLogTime > REWARDS_CONFIG.SCALING_AND_ROTATION.GLOBAL_REWARD_LOG_INTERVAL_MS) {
                this.lastGlobalLogTime = now;
                let totalDailyRewards = 0;
                for (const s of this.activeMarkets.values()) {
                    totalDailyRewards += (s.gammaMarket.clobRewards?.[0]?.rewardsDailyRate || 0);
                }
                console.log(`\n================================================================================`);
                console.log(`GLOBAL REWARD MONITOR | Active Markets: ${this.activeMarkets.size} | Total Daily Rewards Est: $${totalDailyRewards.toFixed(2)}`);
                console.log(`================================================================================\n`);
            }


            // Fetch Share Balances for Sells (prevent "Insufficient Funds" on Sells)
            let yesShareBal = 0;
            let noShareBal = 0;
            try {
                const [yBal, nBal] = await Promise.all([
                    this.clobClient.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: state.yesTokenId }),
                    this.clobClient.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: state.noTokenId })
                ]);
                yesShareBal = Number(yBal.balance || 0) / 1e6;
                noShareBal = Number(nBal.balance || 0) / 1e6;
            } catch (e) {
                // console.warn("Failed to fetch share balances, defaulting to 0 Sells", e);
            }

            const feeRateYes = await this.gammaClient.getFeeRate(state.yesTokenId) || 0;
            const feeRateNo = await this.gammaClient.getFeeRate(state.noTokenId) || 0;

            // FIX 2 (MANDATORY): Enforce minShares on EACH ladder rung individually
            // If rawSize splits result in ANY order < minShares, collapse ladder.
            if (useLadder) {
                const minLevelPercent = Math.max(...ladderLevels.map(l => l.sizePercent));
                // Inverse: If rawSize * minPercent < minShares, it fails.
                // So rawSize must be >= minShares / minPercent
                const minRequiredRaw = Math.ceil(state.rewardsMinSize / minLevelPercent);

                if (rawSize < minRequiredRaw) {
                    ladderLevels = [{ distance: ladderLevels[0].distance, sizePercent: 1.0 }];
                    // console.log(`[Ladder] Collapsed to single order. Raw ${rawSize} < Required ${minRequiredRaw}`);
                }
            }

            // LADDER-BASED ORDER PLACEMENT
            // Iterate through each ladder level and create orders
            let batchCostSoFar = 0;
            for (let levelIdx = 0; levelIdx < ladderLevels.length; levelIdx++) {
                const level = ladderLevels[levelIdx];
                // FIX 1: Rigid Size Flooring & MinShares Check
                const levelSize = Math.floor(rawSize * level.sizePercent);

                if (levelSize < state.rewardsMinSize) {
                    // console.warn(`[Rewards] Ladder Level ${levelIdx} size ${levelSize} < Min ${state.rewardsMinSize}. Skipping.`);
                    continue;
                }

                // Calculate expected score for this level
                const expectedScore = state.rewardsMaxSpread ? ScoringCalc.calculateScore({
                    distance: level.distance,
                    maxSpread: state.rewardsMaxSpread,
                    size: levelSize
                }) : 0;

                // Apply asymmetric adjustment if enabled
                let yesDistance = level.distance;
                let noDistance = level.distance;

                if (useAsymmetric) {
                    const yesStrategy = OrderbookAnalyzer.getQuotingStrategy(
                        yesOb,
                        yesMid,
                        level.distance,
                        REWARDS_CONFIG.REWARD_OPTIMIZATION.ASYMMETRIC_SENSITIVITY
                    );

                    if (yesStrategy.strategy === 'asymmetric' && yesStrategy.distances) {
                        yesDistance = yesStrategy.distances.bidDistance;
                    }

                    const noStrategy = OrderbookAnalyzer.getQuotingStrategy(
                        noOb,
                        noMid || (1 - yesMid),
                        level.distance,
                        REWARDS_CONFIG.REWARD_OPTIMIZATION.ASYMMETRIC_SENSITIVITY
                    );

                    if (noStrategy.strategy === 'asymmetric' && noStrategy.distances) {
                        noDistance = noStrategy.distances.bidDistance;
                    }

                    // FIX 5: Clamp Asymmetric Distances
                    if (state.rewardsMaxSpread) {
                        yesDistance = Math.min(yesDistance, state.rewardsMaxSpread);
                        noDistance = Math.min(noDistance, state.rewardsMaxSpread);
                    }
                }

                // Calculate Prices for this level
                const yesBuyPrice = this.roundToTick(yesMid - yesDistance, tickNum);
                const yesSellPrice = this.roundToTick(yesMid + yesDistance, tickNum);

                const effectiveNoMid = noMid ?? (1 - yesMid);
                const noBuyPrice = this.roundToTick(effectiveNoMid - noDistance, tickNum);
                const noSellPrice = this.roundToTick(effectiveNoMid + noDistance, tickNum);

                // Two-sided validation
                if (needsTwoSided) {
                    if (!isValidPrice(yesBuyPrice) || !isValidPrice(noBuyPrice)) {
                        continue; // Skip this level
                    }
                }

                // Calculate cost for this level
                const costYes = isValidPrice(yesBuyPrice) ? levelSize * yesBuyPrice * 1.01 : 0;
                const costNo = isValidPrice(noBuyPrice) ? levelSize * noBuyPrice * 1.01 : 0;
                const levelCost = costYes + costNo;

                // FIX 3: Use Global Tracking Balance (Break if empty)
                if (batchCostSoFar + levelCost > this.globalTrackingBalance) {
                    break; // Abort further ladder levels to prevent partial batches
                }
                batchCostSoFar += levelCost;

                // YES BUY
                if (isValidPrice(yesBuyPrice)) {
                    ordersToPost.push({
                        tokenID: state.yesTokenId,
                        price: yesBuyPrice,
                        side: Side.BUY,
                        size: levelSize,
                        feeRateBps: feeRateYes,
                        _cost: levelSize * yesBuyPrice * 1.01,
                        _ladderLevel: levelIdx,
                        _expectedScore: expectedScore
                    });
                }

                // YES SELL -- Only if we have shares
                if (isValidPrice(yesSellPrice) && yesShareBal >= levelSize) {
                    ordersToPost.push({
                        tokenID: state.yesTokenId,
                        price: yesSellPrice,
                        side: Side.SELL,
                        size: levelSize,
                        feeRateBps: feeRateYes,
                        _ladderLevel: levelIdx,
                        _expectedScore: expectedScore
                    });
                }

                // NO BUY
                if (isValidPrice(noBuyPrice)) {
                    ordersToPost.push({
                        tokenID: state.noTokenId,
                        price: noBuyPrice,
                        side: Side.BUY,
                        size: levelSize,
                        feeRateBps: feeRateNo,
                        _cost: levelSize * noBuyPrice * 1.01,
                        _ladderLevel: levelIdx,
                        _expectedScore: expectedScore
                    });
                }

                // NO SELL -- Only if we have shares
                if (isValidPrice(noSellPrice) && noShareBal >= levelSize) {
                    ordersToPost.push({
                        tokenID: state.noTokenId,
                        price: noSellPrice,
                        side: Side.SELL,
                        size: levelSize,
                        feeRateBps: feeRateNo,
                        _ladderLevel: levelIdx,
                        _expectedScore: expectedScore
                    });
                }
            }

            // If no orders were created, log and return
            if (ordersToPost.length === 0) {
                this.logAction(state.gammaMarket.question, "SKIP", -1, -1, -1, "No valid orders at ladder levels");
                return;
            }

            // FIX 3: Enforce "Two-Sided BUY or Nothing" Guard
            const buyYes = ordersToPost.find(o => o.tokenID === state.yesTokenId && o.side === Side.BUY);
            const buyNo = ordersToPost.find(o => o.tokenID === state.noTokenId && o.side === Side.BUY);

            if (!buyYes || !buyNo) {
                this.logAction(state.gammaMarket.question, "SKIP", -1, -1, -1, "Missing two-sided BUYs - cannot score");
                return;
            }

            // FIX 2: Global Liquidity Check (Prevent partial ladders)
            let totalBatchCost = 0;
            ordersToPost.forEach(o => {
                if (o.side === Side.BUY && o._cost) totalBatchCost += o._cost;
            });

            if (totalBatchCost > this.globalTrackingBalance) {
                this.logAction(state.gammaMarket.question, "SKIP", -1, -1, -1, `Insufficient Global Liquidity ($${this.globalTrackingBalance.toFixed(2)} < $${totalBatchCost.toFixed(2)})`);
                return;
            }

            // Deduct immediately (pessimistic lock)
            this.globalTrackingBalance -= totalBatchCost;

            console.log(`Preparing batch of ${ordersToPost.length} orders for ${state.gammaMarket.question.slice(0, 40)}...`);

            for (let i = 0; i < ordersToPost.length; i++) {
                const params = ordersToPost[i];

                // FIX 5: Final Safety Net Logic
                if (params.size < state.rewardsMinSize) {
                    // console.warn(`[Rewards] Skipping order size ${params.size} < Min ${state.rewardsMinSize}`);
                    continue;
                }

                // SPREAD VALIDATION (Strict)
                // SPREAD VALIDATION (Strict via API Mid)
                let midToCheck = 0;
                if (params.tokenID === state.yesTokenId && yesMid) midToCheck = yesMid;
                else if (params.tokenID === state.noTokenId && noMid) midToCheck = noMid;

                if (midToCheck > 0) {
                    const dist = Math.abs(params.price - midToCheck);
                    // Use small epsilon for float comparison safety
                    if (dist > state.rewardsMaxSpread + 0.0001) {
                        console.warn(`[Rewards] Skipping order - Spread too wide (${dist.toFixed(3)} > ${state.rewardsMaxSpread}) for ${state.gammaMarket.question.slice(0, 20)}`);
                        continue;
                    }
                }

                if (process.env.DRY_RUN === "true") {
                    console.log(`[DRY RUN] ${params.side} ${params.size} @ ${params.price}`);
                    continue;
                }

                try {
                    // Sign each order
                    // @ts-ignore
                    const signed = await this.clobClient.createOrder({
                        tokenID: params.tokenID,
                        price: params.price,
                        side: params.side,
                        size: params.size,
                        feeRateBps: params.feeRateBps,
                        expiration: Math.floor(Date.now() / 1000) + REWARDS_CONFIG.TEMPORAL.GTD_EXPIRY_SECONDS
                    }, {
                        tickSize: String(state.tickSize) as TickSize, // FIX: TickSize must be string
                        negRisk: state.negRisk,
                    });
                    const { _cost, ...rest } = params;
                    signedOrders.push(signed);
                    validOrders.push(rest);
                } catch (e) {
                    console.error("Signing failed for order:", e);
                }
            }

            if (signedOrders.length > 0) {
                console.log(`Posting ${signedOrders.length} signed orders...`);

                const ordersArg = signedOrders.map(o => ({
                    order: o,
                    orderType: OrderType.GTD,  // GTD supports expiration timestamps
                    postOnly: true
                }));

                // @ts-ignore
                const responses = await this.clobClient.postOrders(ordersArg);

                if (Array.isArray(responses)) {
                    // Check for ANY balance failures to trigger backoff immediately
                    // Using "some" instead of "every" to be strict about stopping spam
                    const anyBalanceError = responses.some(r =>
                        r.errorMsg?.includes("not enough balance") || r.errorMsg?.includes("allowance")
                    );

                    if (anyBalanceError) {
                        console.warn(`[Balance] Insufficient funds detected. Pausing ${state.marketId.slice(0, 10)}...`);
                        this.logAction(state.gammaMarket.question, "LOW FUNDS", -1, -1, -1, `Insufficient funds detected. Pausing 2m.`);
                        this.lowBalancePauseUntil = Date.now() + 120000;
                        return; // FAST EXIT
                    }

                    for (let i = 0; i < responses.length; i++) {
                        const r = responses[i];
                        const input = validOrders[i];

                        if (r.success && r.orderID) {
                            state.orders.push({
                                orderId: r.orderID,
                                tokenId: input.tokenID,
                                price: input.price,
                                side: input.side,
                                size: input.size,
                                placedAt: Date.now(),
                                ladderLevel: input._ladderLevel,
                                expectedScore: input._expectedScore
                            });
                        } else if (r.errorMsg) {
                            console.error("Batch Order Error:", r.errorMsg);
                        }
                    }
                } else if ((responses as any).orderID) {
                    const r = responses as any;
                    const input = validOrders[0];
                    if (r.success) {
                        state.orders.push({
                            orderId: r.orderID,
                            tokenId: input.tokenID,
                            price: input.price,
                            side: input.side,
                            size: input.size,
                            placedAt: Date.now(),
                            ladderLevel: input._ladderLevel,
                            expectedScore: input._expectedScore
                        });
                    }
                }
            }

            // 4. Verify Scoring Status (User Request)
            const newOrderIds = signedOrders.map(o => o.orderID).filter(Boolean);

            // FIX 1: Filter to BUY orders only (SELLs don't reliable score)
            const recentBuyOrders = state.orders.filter(
                o => Date.now() - o.placedAt < 2000 && o.side === Side.BUY
            );

            if (recentBuyOrders.length > 0) {
                await new Promise(r => setTimeout(r, 2000)); // Wait for matching engine

                try {
                    // Check scoring status
                    // @ts-ignore
                    const scoreRes = await this.clobClient.areOrdersScoring({
                        orderIds: recentBuyOrders.map(o => o.orderId)
                    });

                    const scoringMap = (scoreRes as any).scoring || scoreRes;

                    let scoringCount = 0;
                    for (const o of recentBuyOrders) {
                        if (scoringMap[o.orderId] === true) scoringCount++;
                    }

                    if (scoringCount === recentBuyOrders.length) {
                        console.log(`[Rewards] ✅ All ${scoringCount} BUY orders are SCORING.`);
                    } else {
                        console.warn(`[Rewards] ⚠️ Only ${scoringCount}/${recentBuyOrders.length} BUY orders are SCORING.`);
                    }
                } catch (e) {
                    console.warn("Failed to verify scoring status:", e);
                }
            }

        } catch (e) {
            console.error(`Order placement failed for ${state.marketId}:`, e);
        }
    }

    // --- Position Management (Fill Handling) ---
    private async runPositionManagement(state: MarketState) {
        // 1. Sync Inventory (Verify what we actually have)
        // We do this every loop in managing mode, or throttle it?
        // Ideally verify every few seconds. For now, trust local + verify.

        // 2. Logic: "Aggressive limit exit"
        // YES = +100, NO = 0.
        // Goal: Sell YES.

        const now = Date.now();
        const fillAge = now - (state.lastFillTime || now);

        // CRITICAL FIX: Trust local inventory for first 10 seconds after fill
        // API has indexing lag and will return 0 immediately after fill
        const TRUST_LOCAL_PERIOD_MS = 10000;

        // Phase 22: Lowered threshold from > 1 to > 0.1 to catch smaller fills
        const sideToExit = state.inventory.yes > 0.1 ? "YES" : (state.inventory.no > 0.1 ? "NO" : null);

        if (!sideToExit) {
            // Only verify via API if enough time has passed
            if (fillAge < TRUST_LOCAL_PERIOD_MS) {
                console.warn(`[Inventory] Fill too recent (${fillAge}ms). Waiting for API sync...`);
                return; // Don't switch to QUOTING yet - wait for API to catch up
            }

            state.mode = "QUOTING";
            this.logAction(state.gammaMarket.question, "RESUME", -1, -1, -1, "Inventory cleared. Resuming quotes.");
            return;
        }

        const tokenId = sideToExit === "YES" ? state.yesTokenId : state.noTokenId;
        let size = sideToExit === "YES" ? state.inventory.yes : state.inventory.no;

        // Only verify via API after trust period
        if (fillAge >= TRUST_LOCAL_PERIOD_MS) {
            try {
                // @ts-ignore
                const bal = await this.clobClient.getBalanceAllowance({
                    asset_type: AssetType.CONDITIONAL,
                    token_id: tokenId
                });

                // FIX: Safe parsing with fallback
                const apiSize = parseFloat(bal.balance || "0") / 1e6;
                const allowance = parseFloat(bal.allowance || "0") / 1e6;

                console.log(`[Inventory] ${sideToExit} API: ${apiSize.toFixed(2)}, Local: ${size.toFixed(2)}, Allow: ${allowance.toFixed(2)}`);

                // Use MAX of local and API (API might still be behind)
                if (apiSize > size) size = apiSize;

                // Sync local
                if (sideToExit === "YES") state.inventory.yes = size;
                else state.inventory.no = size;

                // Check allowance
                if (size > 0.1 && (isNaN(allowance) || allowance < size)) {
                    console.log(`[Inventory] Approving ${tokenId}...`);
                    // @ts-ignore
                    await this.clobClient.updateBalanceAllowance({
                        asset_type: AssetType.CONDITIONAL,
                        token_id: tokenId
                    });
                }
            } catch (e) {
                console.warn(`[Inventory] API check failed, using local: ${size}`, e);
            }
        } else {
            console.log(`[Inventory] Using local state (fill ${fillAge}ms ago): ${sideToExit} = ${size.toFixed(2)}`);
        }

        if (size < 0.1) {
            state.mode = "QUOTING";
            this.logAction(state.gammaMarket.question, "RESUME", -1, -1, -1, "Inventory empty.");
            return;
        }

        // --- PHASE 2: CTF MERGE INTEGRATION ---
        if (REWARDS_CONFIG.CAPITAL_EFFICIENCY.ENABLE_MERGE && state.inventory.yes > 0.1 && state.inventory.no > 0.1) {
            const amountToMerge = Math.min(state.inventory.yes, state.inventory.no);
            this.logAction(state.gammaMarket.question, "MERGE", -1, -1, -1, `Merging ${amountToMerge.toFixed(2)} YES+NO back to USDC`);
            try {
                // @ts-ignore
                await mergePositions(state.gammaMarket.conditionId, amountToMerge, this.relayClient);
                state.inventory.yes -= amountToMerge;
                state.inventory.no -= amountToMerge;

                // Refresh size after merge
                size = sideToExit === "YES" ? state.inventory.yes : state.inventory.no;
                if (size < 0.1) {
                    state.mode = "QUOTING";
                    // Cancel all remaining orders for this market
                    const allIds = state.orders.map(o => o.orderId);
                    if (allIds.length > 0) {
                        await this.clobClient.cancelOrders(allIds);
                        state.orders = [];
                    }
                    this.logAction(state.gammaMarket.question, "RESUME", -1, -1, -1, "Inventory cleared via Merge.");
                    return;
                }
            } catch (e) {
                console.error(`[Merge] Failed for ${state.marketId}:`, e);
            }
        }

        const tick = Number(state.tickSize) || 0.01;

        // 1. EXIT ORDER (The side we hold)
        const exitTokenId = tokenId;
        const exitOb = await this.getOrderBookCached(exitTokenId);
        if (exitOb) {
            const bestBid = Number(exitOb.bids[0]?.price || 0);
            const bestAsk = Number(exitOb.asks[0]?.price || 1);
            const validAsk = exitOb.asks.length > 0;

            let exitPrice: number;
            if (validAsk) {
                const mid = (bestBid + bestAsk) / 2;
                exitPrice = Math.min(bestAsk, mid + 0.005);
            } else {
                exitPrice = bestBid + 0.02;
            }

            if (fillAge > 5000) {
                if (validAsk) {
                    const mid = (bestBid + bestAsk) / 2;
                    exitPrice = mid - 0.002;
                    if (exitPrice < bestBid + 0.001) exitPrice = bestBid + 0.001;
                } else {
                    exitPrice = bestBid + 0.005;
                }
            }

            if (fillAge > 30000) {
                exitPrice = bestBid;
                this.logAction(state.gammaMarket.question, "DUMP", -1, -1, -1, `Emergency Exit after 30s. Px ${exitPrice}`);
            }

            exitPrice = Math.round(exitPrice / tick) * tick;
            const existingExit = state.orders.find(o => o.tokenId === exitTokenId && o.side === Side.SELL);

            if (existingExit) {
                if (Math.abs(existingExit.price - exitPrice) >= tick) {
                    this.logAction(state.gammaMarket.question, "UPDATE", -1, exitPrice, -1, `Updating Exit from ${existingExit.price} to ${exitPrice}`);
                    try {
                        // @ts-ignore
                        await this.clobClient.cancelOrder({ orderID: existingExit.orderId });
                        state.orders = state.orders.filter(o => o.orderId !== existingExit.orderId);
                    } catch (e) { }
                }
            } else {
                try {
                    this.logAction(state.gammaMarket.question, "EXIT", -1, exitPrice, -1, `Exiting ${sideToExit} ${size.toFixed(1)} @ ${exitPrice}`);
                    const postOnly = fillAge < 30000;
                    // @ts-ignore
                    const order = await this.clobClient.createOrder({
                        tokenID: exitTokenId,
                        price: exitPrice,
                        side: Side.SELL,
                        size: size,
                        feeRateBps: 0,
                    }, { tickSize: state.tickSize });
                    // @ts-ignore
                    const posted = await this.clobClient.postOrder(order, postOnly ? OrderType.GTC : OrderType.FOK);
                    if (posted?.orderID) {
                        state.orders.push({ orderId: posted.orderID, tokenId: exitTokenId, price: exitPrice, side: Side.SELL, size, placedAt: Date.now() });
                    }
                } catch (e) { console.error("Exit placement failed:", e); }
            }
        }

        // 2. RECYCLING ORDER (The opposite side)
        if (REWARDS_CONFIG.CAPITAL_EFFICIENCY.ENABLE_RECYCLING && fillAge < 60000) { // Only recycle for first 60s
            const oppositeSide = sideToExit === "YES" ? "NO" : "YES";
            const recycleTokenId = oppositeSide === "YES" ? state.yesTokenId : state.noTokenId;
            const recycleOb = await this.getOrderBookCached(recycleTokenId);

            if (recycleOb) {
                const bestBid = Number(recycleOb.bids[0]?.price || 0);
                const bestAsk = Number(recycleOb.asks[0]?.price || 1);
                const mid = (bestBid + bestAsk) / 2;

                // Use tightest ladder level for recycling
                const recycleDistance = REWARDS_CONFIG.REWARD_OPTIMIZATION.LADDER_LEVELS[0].distance;
                let recyclePrice = Math.round((mid - recycleDistance) / tick) * tick;
                if (recyclePrice < 0.01) recyclePrice = 0.01;

                const existingRecycle = state.orders.find(o => o.tokenId === recycleTokenId && o.side === Side.BUY);

                if (existingRecycle) {
                    if (Math.abs(existingRecycle.price - recyclePrice) >= tick) {
                        this.logAction(state.gammaMarket.question, "UPDATE", -1, recyclePrice, -1, `Updating Recycle ${oppositeSide} to ${recyclePrice}`);
                        try {
                            // @ts-ignore
                            await this.clobClient.cancelOrder({ orderID: existingRecycle.orderId });
                            state.orders = state.orders.filter(o => o.orderId !== existingRecycle.orderId);
                        } catch (e) { }
                    }
                } else {
                    // Check balance for recycling (fetch only if needed)
                    try {
                        const balRes = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                        const available = parseFloat(balRes.balance) / 1e6;
                        // FIX 2 (MANDATORY): Enforce strict minShares for Recycling (No exceptions)
                        const recycleSize = state.rewardsMinSize;
                        const cost = recycleSize * recyclePrice * 1.01;

                        if (available > cost) {
                            this.logAction(state.gammaMarket.question, "RECYCLE", -1, recyclePrice, -1, `Recycling ${oppositeSide} ${recycleSize} @ ${recyclePrice}`);
                            // @ts-ignore
                            const order = await this.clobClient.createOrder({
                                tokenID: recycleTokenId,
                                price: recyclePrice,
                                side: Side.BUY,
                                size: recycleSize,
                                feeRateBps: 0,
                                expiration: Math.floor(Date.now() / 1000) + REWARDS_CONFIG.TEMPORAL.GTD_EXPIRY_SECONDS
                            }, { tickSize: state.tickSize });
                            // @ts-ignore
                            const posted = await this.clobClient.postOrder(order, OrderType.GTD);
                            if (posted?.orderID) {
                                state.orders.push({ orderId: posted.orderID, tokenId: recycleTokenId, price: recyclePrice, side: Side.BUY, size: recycleSize, placedAt: Date.now() });

                                // FIX 4: Unblock Quoting during Recycling
                                // Allow restart if only recycle order exists (prevents getting stuck in MANAGING)
                                if (state.orders.length === 1 && state.orders[0].side === Side.BUY) {
                                    state.orders = [];
                                }
                            }
                        }
                    } catch (e) { console.error("Recycle placement failed:", e); }
                }
            }
        }
    }
}
