import { REWARDS_CONFIG } from "../config/rewardsConfig.js";
import { GammaMarket } from "../clients/gamma-api.js";

/**
 * Calculates the score for a market based on the formula:
 * Score = (rewards / min_shares) * time_to_resolution_weight * (1 / competition_level)
 */
export function calculateMarketScore(
    dailyRewards: number,
    minShares: number,
    hoursToResolution: number,
    competitionLevel: number // 0-5 bars (0 is disallowed, but formula handles it)
): number {
    if (minShares <= 0) return 0;
    if (competitionLevel <= 0) competitionLevel = 0.5; // Avoid division by zero, treat as very low

    // Time weight: 1 / (hours + 0.1)
    const timeWeight = 1 / (hoursToResolution + 0.1);

    return (dailyRewards / minShares) * timeWeight * (1 / competitionLevel);
}

export function getMinDailyRewards(tier: number): number {
    if (tier === 1) return REWARDS_CONFIG.TIER_1.MIN_DAILY_REWARDS;
    if (tier === 2) return REWARDS_CONFIG.TIER_2.MIN_DAILY_REWARDS;
    if (tier === 3) return REWARDS_CONFIG.TIER_3.MIN_DAILY_REWARDS;
    return 1000;
}

/**
 * Estimates competition level based on reward-weighted depth near midpoint.
 * Replaces simple order count.
 */
export function estimateCompetition(orderbook: any, mid: number, maxSpreadDecimal: number): number {
    const v = maxSpreadDecimal; // e.g., 0.03 for 3 cents
    let totalQ = 0;

    if (!orderbook || !orderbook.bids || !orderbook.asks) return 2; // Default if missing

    // Sum bid liquidity scores
    for (const bid of orderbook.bids || []) {
        const price = Number(bid.price);
        const size = Number(bid.size);
        const spread = Math.abs(mid - price);

        if (spread <= v) {
            const score = Math.pow((v - spread) / v, 2) * size;
            totalQ += score;
        }
    }

    // Sum ask liquidity scores
    for (const ask of orderbook.asks || []) {
        const price = Number(ask.price);
        const size = Number(ask.size);
        const spread = Math.abs(price - mid);

        if (spread <= v) {
            const score = Math.pow((v - spread) / v, 2) * size;
            totalQ += score;
        }
    }

    // Map totalQ to "Bars" (1-5) based on real data calibration
    if (totalQ < 50) return 1;        // Very Low (empty/thin books)
    if (totalQ < 200) return 2;       // Low
    if (totalQ < 1000) return 3;      // Medium
    if (totalQ < 5000) return 4;      // High
    return 5;                          // Very High
}

/**
 * robustly extracts daily rewards from Gamma market object.
 * Handles inconsistent API fields (rewardsDailyRate vs rewardsAmount).
 */
export function extractDailyRewards(market: GammaMarket): number {
    if (!market.clobRewards) return 0;

    // Some API responses might be single object instead of array?
    // GammaMarket definition has clobRewards: ClobReward[] | null
    // But check just in case.
    const rewards = Array.isArray(market.clobRewards) ? market.clobRewards : [market.clobRewards];

    let total = 0;
    for (const r of rewards) {
        if (r.rewardsDailyRate) {
            total += Number(r.rewardsDailyRate);
        } else if (r.rewardsAmount) {
            // If only total amount is given, strictly we need rate.
            // But if it's a short term campaign, amount might suffice as proxy?
            // User suggestion: "if (r.rewardsDailyRate) total += ... else if (r.rewardsAmount) total += ..."
            // We'll follow that 
            total += Number(r.rewardsAmount);
        }
    }
    return total;
}

/**
 * Checks if a market fits the Tier 1 criteria.
 */
export function isTier1(
    dailyRewards: number,
    competitionLevel: number,
    minShares: number,
    hoursToResolution: number,
    spreadCents: number,
    midPrice: number
): boolean {
    const config = REWARDS_CONFIG.TIER_1;
    // Comp is 1-5. Yield = Rewards / Comp.
    // Example: $300 / 5 = 60 (>50 PASS). $50 / 1 = 50 (PASS). $50 / 5 = 10 (FAIL).
    const yieldScore = dailyRewards / (competitionLevel || 1);

    return (
        yieldScore >= (config.MIN_YIELD_SCORE || 0) &&
        dailyRewards >= config.MIN_DAILY_REWARDS &&
        competitionLevel <= config.MAX_COMPETITION_BARS &&
        minShares <= config.MIN_SHARES_TARGET &&
        hoursToResolution <= config.MAX_RESOLUTION_HOURS &&
        spreadCents <= config.MAX_SPREAD_CENTS &&
        midPrice >= config.MIN_MID_PRICE &&
        midPrice <= config.MAX_MID_PRICE
    );
}

/**
 * Checks if a market fits the Tier 2 criteria.
 */
export function isTier2(
    dailyRewards: number,
    competitionLevel: number,
    minShares: number,
    hoursToResolution: number,
    spreadCents: number,
    midPrice: number
): boolean {
    const config = REWARDS_CONFIG.TIER_2;
    const yieldScore = dailyRewards / (competitionLevel || 1);

    return (
        yieldScore >= (config.MIN_YIELD_SCORE || 0) &&
        dailyRewards >= config.MIN_DAILY_REWARDS &&
        competitionLevel <= config.MAX_COMPETITION_BARS &&
        minShares <= config.MIN_SHARES_TARGET &&
        hoursToResolution <= config.MAX_RESOLUTION_DAYS * 24 &&
        spreadCents <= config.MAX_SPREAD_CENTS &&
        midPrice >= config.MIN_MID_PRICE &&
        midPrice <= config.MAX_MID_PRICE
    );
}

/**
 * Checks if a market fits the Tier 3 criteria.
 */
export function isTier3(
    dailyRewards: number,
    competitionLevel: number,
    minShares: number,
    hoursToResolution: number,
    spreadCents: number
): boolean {
    const config = REWARDS_CONFIG.TIER_3;
    return (
        dailyRewards >= config.MIN_DAILY_REWARDS &&
        competitionLevel <= config.MAX_COMPETITION_BARS &&
        minShares <= config.MIN_SHARES_TARGET &&
        hoursToResolution <= config.MAX_RESOLUTION_DAYS * 24 &&
        spreadCents <= config.MAX_SPREAD_CENTS
    );
}

/**
 * Checks hard rejection criteria.
 */
export function isHardRejected(
    hoursToResolution: number,
    competitionLevel: number,
    midPrice: number,
    isDualSidedQuoted: boolean = false
): boolean {
    const limits = REWARDS_CONFIG.HARD_LIMITS;

    if (hoursToResolution < limits.MIN_RESOLUTION_HOURS) return true;
    if (competitionLevel < limits.MIN_COMPETITION_BARS) return true; // 0 bars = dead

    // Mid price check, unless dual sided quoted
    if (!isDualSidedQuoted) {
        if (midPrice < limits.MIN_PRICE || midPrice > limits.MAX_PRICE) return true;
    }

    return false;
}
