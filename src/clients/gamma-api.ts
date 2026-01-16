export interface GammaMarket {
    id: string;
    question: string;
    conditionId: string;
    market_slug: string;
    end_date_iso: string;
    endDate?: string; // from JSON
    active: boolean;
    clob_token_ids: string[];
    // Reward fields from Gamma
    min_incentive_size?: number; // Raw JSON field
    max_incentive_spread?: number; // Raw JSON field
    rewardsMinSize?: number; // Mapped field
    rewardsMaxSpread?: number; // Mapped field

    // Order param fields
    minimum_tick_size?: number; // Raw JSON field
    tickSize?: number; // Mapped field
    neg_risk?: boolean; // Raw JSON field
    negRisk?: boolean; // Mapped field

    clobRewards?: {
        id: string;
        rewardsDailyRate: number;
        rewardsAmount: number;
    }[];
    // Order book stats (partially available in Gamma response)
    competitive?: number; // 0-1 score? "active buckets"?
    volume24hr?: number;
    liquidity?: number; // or liquidityClob
    lastTradePrice?: number;
    spread?: number;
    bestBid?: number;
    bestAsk?: number;
}

export interface GammaEvent {
    id: string;
    title: string;
    markets: GammaMarket[];
    end_date_iso?: string;
    endDate?: string;
}

const GAMMA_API_URL = "https://gamma-api.polymarket.com";

export class GammaClient {
    async getEvents(queryParams: string): Promise<GammaEvent[]> {
        const url = `${GAMMA_API_URL}/events?${queryParams}`;
        console.log(`Fetching Gamma Events: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Gamma API Error: ${response.status} ${response.statusText}`);
        }
        const events: GammaEvent[] = await response.json();

        // Post-processing to map fields if necessary
        events.forEach(event => {
            event.markets.forEach(market => {
                this.normalizeMarket(market);
            });
        });

        return events;
    }

    async getMarkets(queryParams: string): Promise<GammaMarket[]> {
        const url = `${GAMMA_API_URL}/markets?${queryParams}`;
        console.log(`Fetching Gamma Markets: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            // 404 is common if the predictive slug doesn't exist yet
            if (response.status === 404) return [];
            throw new Error(`Gamma API Error: ${response.status} ${response.statusText}`);
        }
        const markets: GammaMarket[] = await response.json();

        // Post-processing
        markets.forEach(market => {
            this.normalizeMarket(market);
        });

        return markets;
    }

    private normalizeMarket(market: any) {
        // Map raw fields to camelCase if they exist
        if (market.condition_id && !market.conditionId) market.conditionId = market.condition_id;
        if (market.min_incentive_size !== undefined) market.rewardsMinSize = market.min_incentive_size;
        if (market.max_incentive_spread !== undefined) market.rewardsMaxSpread = market.max_incentive_spread;
        if (market.minimum_tick_size !== undefined) market.tickSize = market.minimum_tick_size;
        if (market.neg_risk !== undefined) market.negRisk = market.neg_risk;

        // Fix Token IDs (map clobTokenIds -> clob_token_ids and parse if string)
        if (market.clobTokenIds) {
            let raw = market.clobTokenIds;
            if (typeof raw === 'string') {
                try {
                    market.clob_token_ids = JSON.parse(raw);
                } catch (e) {
                    // console.error("Failed to parse clobTokenIds:", raw);
                    market.clob_token_ids = [];
                }
            } else if (Array.isArray(raw)) {
                market.clob_token_ids = raw;
            }
        }
    }

    async getFeeRate(tokenId: string): Promise<number> {
        try {
            // Use CLOB API for fee rate
            const url = `https://clob.polymarket.com/fee-rate?token_id=${tokenId}`;
            const response = await fetch(url);

            if (!response.ok) {
                // console.warn(`[GammaClient] Fee rate fetch failed: ${response.status}`);
                return 0; // Default to 0 on error
            }

            const data = await response.json();

            // API returns { fee_rate_bps: "0" } or similar. 
            // Already in BPS, so just return as number.
            return Number(data.fee_rate_bps || 0);
        } catch (error: any) {
            console.warn(`[GammaClient] Failed to fetch fee rate for ${tokenId}:`, error.message);
            return 0;
        }
    }

    async getCrypto15MinMarkets(): Promise<string[]> {
        // Fetch ALL active markets to avoid tag issues
        const events = await this.getEvents("active=true&closed=false");

        const targetAssets: string[] = [];

        for (const event of events) {
            const title = event.title.toLowerCase();

            // Relaxed Filter: Checks for "15" AND ("min" or "m") to catch "15min", "15 min", "15m"
            // Also explicitly check for specific crypto keywords
            const is15Min = (title.includes("15") && (title.includes("min") || title.includes("m")));

            const coins = ["btc", "bitcoin", "eth", "ethereum", "xrp", "sol", "solana"];
            const isTargetCrypto = coins.some(c => title.includes(c));

            if (is15Min && isTargetCrypto) {
                for (const market of event.markets) {
                    // Only active markets
                    if (market.active) {
                        targetAssets.push(...market.clob_token_ids);
                    }
                }
            }
        }

        return targetAssets;
    }
}
