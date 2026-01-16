import { TickSize } from "@polymarket/clob-client";

export const REWARDS_CONFIG = {
    // 1️⃣ Market Selection: Yield-Based Waterfalls
    // We trust Yield Score (Rewards/Comp) to be the primary quality signal.
    // Constraints (Shares/Spread) are relaxed to avoid filtering out "Whale" opportunities.
    TIER_1: {
        MIN_YIELD_SCORE: 50,         // Excellent Payout per Dollar
        MAX_COMPETITION_BARS: 10,    // Ignored
        MIN_DAILY_REWARDS: 50,
        MIN_SHARES_PREFER: 10,
        MIN_SHARES_TARGET: 500,      // Relaxed from 10 to catch big campaigns
        MAX_RESOLUTION_HOURS: 24 * 365,
        MAX_SPREAD_CENTS: 10,        // Relaxed from 5 to 10
        MIN_MID_PRICE: 0.05,
        MAX_MID_PRICE: 0.95,
    },
    TIER_2: {
        MIN_YIELD_SCORE: 15,         // Good Payout per Dollar
        MAX_COMPETITION_BARS: 10,    // Ignored
        MIN_DAILY_REWARDS: 20,
        MIN_SHARES_TARGET: 500,      // Relaxed
        MAX_RESOLUTION_DAYS: 365 * 2,
        MAX_SPREAD_CENTS: 10,        // Relaxed
        MIN_MID_PRICE: 0.05,
        MAX_MID_PRICE: 0.95,
    },
    TIER_3: {
        MIN_DAILY_REWARDS: 50,
        MAX_COMPETITION_BARS: 5,
        MIN_SHARES_TARGET: 100,
        MAX_RESOLUTION_DAYS: 365 * 3,
        MAX_SPREAD_CENTS: 10,        // 10 cents (Integer)
    },

    // --- Hard Rejection Limits ---
    HARD_LIMITS: {
        MIN_DAILY_REWARDS: 50,
        MIN_RESOLUTION_HOURS: 12,
        MIN_COMPETITION_BARS: 0.1,
        MIN_PRICE: 0.05,
        MAX_PRICE: 0.95,
    },

    // 2️⃣ Capital Allocation
    ALLOCATION: {
        MAX_DEPLOYED_PERCENT: 0.80, // "Use only half my balance"
        PER_MARKET_PERCENT: 0.80,   // 5% per market for 20 markets
        MAX_ACTIVE_MARKETS: 1,     // "Open orders on 20-30 markets"
        EMERGENCY_RESERVE_PERCENT: 0.20,
    },

    // 3️⃣ Monitoring & Rotation
    MONITORING: {
        RECALC_INTERVAL_MS: 30 * 60 * 1000, // 30 mins
        VOLATILITY_WINDOW_SECONDS: 60, // Short window
        MAX_VOLATILITY_CHANGE: 0.05,
        LAST_24H_FREEZE: true,
        MAX_INVENTORY_PERCENT: 0.20,
    },

    // Fill Avoidance (Restored)
    FILL_AVOIDANCE: {
        MIN_DISTANCE_TO_MID: 0.005, // 0.5 cents
        CHECK_INTERVAL_MS: 3000
    },

    // 4️⃣ Global Safety
    SAFETY: {
        MIN_TOTAL_DAILY_REWARDS: 10.0,
    }
};
