import { ClobClient, OrderType, Side, TickSize, MarketReward, AssetType } from "@polymarket/clob-client";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { Strategy } from "./types.js";
import { GammaClient, GammaMarket } from "../clients/gamma-api.js";
import { REWARDS_CONFIG } from "../config/rewardsConfig.js";
import { CONFIG } from "../clients/config.js";
import * as MarketUtils from "../lib/marketUtils.js";
import { ethers } from "ethers";

interface TrackedOrder {
    orderId: string;
    tokenId: string;
    price: number;
    side: Side;
    size: number;
    placedAt: number;
}

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
    private globalNonce = Date.now(); // FIX: Global nonce tracker to guarantee uniqueness

    // Custom Filter for single market mode
    private customFilter?: string;
    private customSpread?: number;
    private customAvoid?: number;

    constructor(customFilter?: string, customSpread?: number, customAvoid?: number) {
        this.customFilter = customFilter;
        this.customSpread = customSpread;
        this.customAvoid = customAvoid;
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
    }

    private printLogHeader() {
        console.log(`\nTime      | Market               | Action   | Spread   | Target   | StopLoss | Details`);
        console.log(`----------|----------------------|----------|----------|----------|----------|----------------------------------------`);
    }

    private logAction(market: string, action: string, spread: number, target: number, stoploss: number, details: string) {
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        const mktName = market.length > 20 ? market.substring(0, 17) + "..." : market.padEnd(20, " ");

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

        const actionStr = action.padEnd(8, " ");
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

                // Reprint header occasionally (every 20 loops)
                if (loopCount % 20 === 0) this.printLogHeader();

                // 1. Fill Avoidance (High Frequency)
                await this.runFillAvoidance();


                // 2. Market Rotation (Low Frequency)
                // Every 30 mins
                if (now - this.lastRotationTime > REWARDS_CONFIG.MONITORING.RECALC_INTERVAL_MS) {
                    await this.scanAndRotate();
                }

                // 3. Order Management (Placement/Update)
                for (const [marketId, state] of this.activeMarkets.entries()) {
                    if (!state.isFrozen) {
                        // 3. Risk Management (Fill Avoidance) - ALWAYS RUN
                        await this.runFillAvoidance(state);

                        // 4. Order Management (Requote/Place) - SKIP IF PAUSED (Low Funds)
                        if (Date.now() < this.lowBalancePauseUntil) {
                            this.logAction(state.gammaMarket.question, "PAUSED", -1, -1, -1, `Paused for funds. Resumes in ${((this.lowBalancePauseUntil - Date.now()) / 1000).toFixed(0)}s.`);
                            continue;
                        }

                        await this.manageMarketOrders(state);
                    }
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

            console.log(`Processing ${rewardMap.size} markets from CLOB...`);

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
                    const isT1 = MarketUtils.isTier1(dailyRewards, competition, minShares, hoursToRes, marketMaxSpreadCents, mid);
                    const isT2 = MarketUtils.isTier2(dailyRewards, competition, minShares, hoursToRes, marketMaxSpreadCents, mid);
                    const isT3 = MarketUtils.isTier3(dailyRewards, competition, minShares, hoursToRes, marketMaxSpreadCents);

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

                        const tickStr = String(market.minimum_tick_size || "0.01");
                        const tickSize = tickStr as TickSize;

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
                            // Delta Neutral Cost Calc
                            dnCost: Math.ceil(minShares * mid + minShares * (1 - mid)),
                            yesPrice: mid,
                            noPrice: 1 - mid,
                            yesCost: Math.ceil(minShares * mid),
                            noCost: Math.ceil(minShares * (1 - mid)),
                            rewardsMinSize: minShares,
                            rewardsMaxSpread: maxSpread
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

            // STRICT USER REQUIREMENT: "Only selected Tier 1 markets will be used"
            // Filter first, then Sort.
            const tier1Candidates = candidates.filter(c => c.tier === 1);
            console.log(`Filtered to ${tier1Candidates.length} Tier 1 Candidates.`);

            // Sort by Yield Score (descending)
            // Priority: "Highest Payout per Dollar"
            tier1Candidates.sort((a, b) => {
                return b.score - a.score;
            });

            // Select top N
            const targetCount = this.customFilter ? 1 : REWARDS_CONFIG.ALLOCATION.MAX_ACTIVE_MARKETS;
            const topMarkets = tier1Candidates.slice(0, targetCount);

            // Update active markets with STATE MERGING
            const newActiveMarkets = new Map<string, MarketState>();

            for (const m of topMarkets) {
                if (this.activeMarkets.has(m.marketId)) {
                    const oldState = this.activeMarkets.get(m.marketId)!;
                    // Preserve order state
                    m.orders = oldState.orders;
                    newActiveMarkets.set(m.marketId, m);
                } else {
                    console.log(`Adding new market: ${m.gammaMarket.question} (Tier ${m.tier}, Rewards ${MarketUtils.extractDailyRewards(m.gammaMarket).toFixed(2)})`);
                    newActiveMarkets.set(m.marketId, m);
                }
            }

            // Cancel orders for dropped
            for (const [id, state] of this.activeMarkets.entries()) {
                if (!newActiveMarkets.has(id)) {
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

                // 2. Fetch Official Spread (API) - SPREAD COMPRESSION CHECK
                let currentSpread = 0.01;
                try {
                    const s = await this.clobClient.getSpread(state.yesTokenId);
                    currentSpread = Number(s.spread);
                } catch (e) {
                    // console.warn("Failed to get spread for avoidance", e);
                }

                const distThreshold = state.dynamicStoploss !== undefined
                    ? state.dynamicStoploss
                    : (this.customAvoid !== undefined ? this.customAvoid : REWARDS_CONFIG.FILL_AVOIDANCE.MIN_DISTANCE_TO_MID);

                let triggered = false;

                // CHECK 1: GLOBAL SPREAD TOO TIGHT?
                // User Rule: "cancel all limits if gap gets less than 0.2c either side" (Implies tight compressed market)
                // We use a safe floor. If spread drops below our STOPLOSS (or 0.2c default), we are in danger.
                // If distThreshold is 0.002,                // CHECK 1: GLOBAL SPREAD TOO TIGHT?
                if (currentSpread < distThreshold) {
                    this.logAction(state.gammaMarket.question, "COMPRESS", currentSpread, -1, distThreshold, `CRITICAL: Spread < SL. Cancelling ALL.`);
                    triggered = true;
                }

                // CHECK 2: INDIVIDUAL ORDERS TOO CLOSE?
                if (!triggered) {
                    for (const order of state.orders) {
                        const mid = order.tokenId === state.yesTokenId ? yesMidVal : noMidVal;
                        // const mid = midInfo.mid; // Old OB logic
                        const dist = Math.abs(order.price - mid);

                        if (dist <= distThreshold) {
                            this.logAction(state.gammaMarket.question, "DRIFT", -1, -1, distThreshold, `Order ${order.price} too close to ${mid.toFixed(4)}. Dist ${dist.toFixed(4)}`);
                            triggered = true;
                            break; // One breach kills all
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

                // The original console.log had a syntax error, fixing it here.
                // It also referenced 'balance', 'locked', 'allowance' which are no longer calculated this way.
                // Adjusting to reflect the new simplified availableUSDC.
                console.log(`[Balance] Available: $${availableUSDC.toFixed(2)}, Required: ~$${(state.rewardsMinSize * 0.5).toFixed(2)}`);

                if (availableUSDC < 1) { // Min threshold to even bother
                    // console.warn(`[Skip] Insufficient Effective USDC: ${availableUSDC.toFixed(2)} (Bal: ${balance.toFixed(2)}, Allow: ${allowance.toFixed(2)})`);
                    return;
                }
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

            // DYNAMIC SPREAD LOGIC (Applied to ALL Markets)
            let targetOffset = this.customSpread !== undefined ? this.customSpread : 0.01;
            let targetAvoid = this.customAvoid !== undefined ? this.customAvoid : REWARDS_CONFIG.FILL_AVOIDANCE.MIN_DISTANCE_TO_MID;

            // User Rule: "run generally also and be dynamic and used for risk management 24/7"
            // We use dynamic (OrderBook based) logic unless manual overrides are set.
            // Even if manual overrides are NOT set, we want to respect the "Dynamic" behavior:
            // Target = CurrentSpread * 2
            // Clamp = RewardsMaxSpread / 2 (if available)

            if (this.customSpread === undefined) {
                // Try to get OFFICIAL spread from API first (Most reliable)
                let currentSpread = 0.01;
                try {
                    const spreadRes = await this.clobClient.getSpread(state.yesTokenId);
                    currentSpread = Number(spreadRes.spread);
                    // If API returns 0 or invalid, fall back to calculated
                    if (currentSpread <= 0.000001) {
                        const bestAsk = Number(yesOb.asks[0]?.price || 1);
                        const bestBid = Number(yesOb.bids[0]?.price || 0);
                        currentSpread = bestAsk - bestBid;
                    }
                } catch (e) {
                    // Fallback to manual calc
                    const bestAsk = Number(yesOb.asks[0]?.price || 1);
                    const bestBid = Number(yesOb.bids[0]?.price || 0);
                    currentSpread = bestAsk - bestBid;
                }

                // Sanity check: If spread is still effectively empty (~1.0), default to a tight spread to probe? 
                // Or better, default to MaxSpread/4 to be safe but competitive?
                // But let's trust the data for now, just sanitize < 0
                if (currentSpread < 0) currentSpread = 0.01;
                if (currentSpread > 0.99) currentSpread = 0.05; // Cap "empty" book spread to 5c to avoid wide quotes

                targetOffset = currentSpread * 2;

                // Constraint: Don't exceed Max Rewards Spread / 2 (stay inside rewards) if defined
                if (state.rewardsMaxSpread !== undefined) {
                    const maxAllowable = state.rewardsMaxSpread / 2;
                    if (targetOffset > maxAllowable) targetOffset = maxAllowable;
                }
                // Constraint: Minimum 1 tick
                if (targetOffset < 0.01) targetOffset = 0.01;

                this.logAction(state.gammaMarket.question, "REQUOTE", currentSpread, targetOffset, -1, `Max: ${state.rewardsMaxSpread ? state.rewardsMaxSpread.toFixed(3) : "None"}`);
            }

            if (this.customAvoid === undefined) {
                targetAvoid = targetOffset * 0.5;
                state.dynamicStoploss = targetAvoid;
                this.logAction(state.gammaMarket.question, "CONFIG", -1, -1, targetAvoid, `Dynamic Stoploss: ${targetAvoid.toFixed(4)} (Cancel if Spread < ${targetAvoid.toFixed(4)})`);
            } else {
                state.dynamicStoploss = undefined;
                this.logAction(state.gammaMarket.question, "CONFIG", -1, -1, this.customAvoid, `Using Manual Stoploss`);
            }




            // Get OFFICIAL midpoints
            const yesMid = await this.getMidpointFromAPI(state.yesTokenId);
            const noMid = await this.getMidpointFromAPI(state.noTokenId);

            if (yesMid === null) {
                // console.log(`[Debug] No Mid Data for ${state.gammaMarket.question.slice(0, 20)}`);
                return;
            }

            const tickNum = Number(state.tickSize);

            // Calculate Prices: Mid +/- Target
            // YES
            const yesBuyPrice = this.roundToTick(yesMid - targetOffset, tickNum);
            const yesSellPrice = this.roundToTick(yesMid + targetOffset, tickNum);

            // NO
            const effectiveNoMid = noMid ?? (1 - yesMid);
            const noBuyPrice = this.roundToTick(effectiveNoMid - targetOffset, tickNum);
            const noSellPrice = this.roundToTick(effectiveNoMid + targetOffset, tickNum);

            // Validate Prices
            const isValidPrice = (p: number) => p > 0.001 && p < 0.999;

            // Two-Sided Requirement: If <0.10 or >0.90, MUST quote both sides
            const needsTwoSided = yesMid < 0.10 || yesMid > 0.90;
            if (needsTwoSided) {
                // For 1c strategy, we demand valid BIDS on both sides (User "place buy yes and no")
                if (!isValidPrice(yesBuyPrice) || !isValidPrice(noBuyPrice)) {
                    // console.warn(`[Skip] Two-sided required but prices invalid for ${state.gammaMarket.question.slice(0,20)}`);
                    return;
                }
            }

            // Budget / Sizing
            const rawSize = Math.max(state.rewardsMinSize, 20); // Min 20 shares to be safe
            let size = rawSize;

            // Calculate Total Cost for Dual Sided Bids
            const costYes = isValidPrice(yesBuyPrice) ? rawSize * yesBuyPrice * 1.01 : 0;
            const costNo = isValidPrice(noBuyPrice) ? rawSize * noBuyPrice * 1.01 : 0;
            const totalCost = costYes + costNo;

            if (totalCost > availableUSDC) {
                this.logAction(state.gammaMarket.question, "LOW FUNDS", -1, -1, -1, `Cost $${totalCost.toFixed(2)} > Bal $${availableUSDC.toFixed(2)}. Pausing 2m.`);
                this.lowBalancePauseUntil = Date.now() + 120000;
                return;
            }

            if (size > 0) {
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

                // YES BUY
                if (isValidPrice(yesBuyPrice)) {
                    ordersToPost.push({
                        tokenID: state.yesTokenId,
                        price: yesBuyPrice,
                        side: Side.BUY,
                        size,
                        feeRateBps: feeRateYes,
                        _cost: size * yesBuyPrice * 1.01
                    });
                    availableUSDC -= (size * yesBuyPrice * 1.01);
                }
                // YES SELL -- Only if we have shares
                if (isValidPrice(yesSellPrice) && yesShareBal >= size) {
                    ordersToPost.push({
                        tokenID: state.yesTokenId,
                        price: yesSellPrice,
                        side: Side.SELL,
                        size,
                        feeRateBps: feeRateYes,
                    });
                }

                // NO BUY
                if (isValidPrice(noBuyPrice)) {
                    // Check remaining funds? We scaled already, but nice to be safe
                    if (availableUSDC >= (size * noBuyPrice * 1.01)) {
                        ordersToPost.push({
                            tokenID: state.noTokenId,
                            price: noBuyPrice,
                            side: Side.BUY,
                            size,
                            feeRateBps: feeRateNo,
                            _cost: size * noBuyPrice * 1.01
                        });
                        availableUSDC -= (size * noBuyPrice * 1.01);
                    }
                }
                // NO SELL -- Only if we have shares
                if (isValidPrice(noSellPrice) && noShareBal >= size) {
                    ordersToPost.push({
                        tokenID: state.noTokenId,
                        price: noSellPrice,
                        side: Side.SELL,
                        size,
                        feeRateBps: feeRateNo,
                    });
                }
            }

            if (ordersToPost.length === 0) {
                // console.log(`[Warning] No valid orders for ${state.gammaMarket.question.slice(0, 20)}`);
                return;
            }

            console.log(`Preparing batch of ${ordersToPost.length} orders for ${state.gammaMarket.question.slice(0, 40)}...`);

            for (let i = 0; i < ordersToPost.length; i++) {
                const params = ordersToPost[i];
                const uniqueNonce = ++this.globalNonce; // FIX: Global increment for uniqueness

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
                        // No expiration for GTC

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
                    orderType: OrderType.GTC,
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
                                placedAt: Date.now()
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
                            placedAt: Date.now()
                        });
                    }
                }
            }

            // 4. Verify Scoring Status (User Request)
            const newOrderIds = signedOrders.map(o => o.orderID).filter(Boolean); // Actually, we need the response IDs, but let's grab from state.orders

            // Filter orders placed just now (last 1s)
            const recentOrders = state.orders.filter(o => Date.now() - o.placedAt < 2000);

            if (recentOrders.length > 0) {
                await new Promise(r => setTimeout(r, 2000)); // Wait for matching engine

                try {
                    // Check scoring status
                    // @ts-ignore
                    const scoreRes = await this.clobClient.areOrdersScoring({
                        orderIds: recentOrders.map(o => o.orderId)
                    });

                    // scoreRes is { [orderId]: boolean }
                    let scoringCount = 0;
                    for (const o of recentOrders) {
                        const isScoring = scoreRes[o.orderId];
                        if (isScoring) scoringCount++;
                        // console.log(`[Rewards] Order ${o.orderId.slice(0,8)}... Scoring: ${isScoring ? "YES" : "NO"}`);
                    }

                    if (scoringCount === recentOrders.length) {
                        console.log(`[Rewards] ✅ All ${scoringCount} new orders are SCORING.`);
                    } else {
                        console.warn(`[Rewards] ⚠️ Only ${scoringCount}/${recentOrders.length} orders are SCORING. Check spread/size.`);
                    }
                } catch (e) {
                    console.warn("Failed to verify scoring status:", e);
                }
            }

        } catch (e) {
            console.error(`Order placement failed for ${state.marketId}:`, e);
        }
    }
}
