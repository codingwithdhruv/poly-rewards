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
        MIN_SHARES_TARGET: 199,      // < 200 as requested
        MAX_RESOLUTION_HOURS: 24 * 365,
        MAX_SPREAD_CENTS: 10,        // Relaxed from 5 to 10
        MIN_MID_PRICE: 0.05,
        MAX_MID_PRICE: 0.95,
    },
    TIER_2: {
        MIN_YIELD_SCORE: 15,         // Good Payout per Dollar
        MAX_COMPETITION_BARS: 10,    // Ignored
        MIN_DAILY_REWARDS: 20,
        MIN_SHARES_TARGET: 199,      // < 200 as requested
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
        MAX_DEPLOYED_PERCENT: 0.95,
        PER_MARKET_PERCENT: 0.20,
        MAX_ACTIVE_MARKETS: 5,      // Increased for parallel rewards
        MAX_BUDGET_PER_MARKET: 150, // Limit risk in a single market
        EMERGENCY_RESERVE_PERCENT: 0.05,
    },

    // 3️⃣ Monitoring & Rotation
    MONITORING: {
        RECALC_INTERVAL_MS: 30 * 60 * 1000,
        VOLATILITY_WINDOW_SECONDS: 60,
        MAX_VOLATILITY_CHANGE: 0.05,
        LAST_24H_FREEZE: true,
        MAX_INVENTORY_PERCENT: 0.20,
    },

    // Fill Avoidance
    FILL_AVOIDANCE: {
        MIN_DISTANCE_TO_MID: 0.005, // 0.5 cents
        CHECK_INTERVAL_MS: 3000,
        // Phase 16: Temporal Persistence
        // Minimum time an order must live before "Soft Drift" cancellation
        MIN_QUOTE_LIFETIME_MS: 30_000,
        DRIFT: {
            SOFT_THRESHOLD: 0.50, // 50% of spread
            HARD_THRESHOLD: 0.15, // 15% of spread (Emergency)
        }
    },

    // 4️⃣ Scaling & Rotation (Phase 3)
    SCALING_AND_ROTATION: {
        BLACKLIST_COOLDOWN_MS: 12 * 60 * 60 * 1000, // 12h
        TOXIC_FILL_THRESHOLD: 3,           // 3 fills in window = toxic
        TOXIC_WINDOW_MS: 1 * 60 * 60 * 1000,
        MIN_YIELD_SCORE_TO_ROTATE: 10,     // Don't rotate if yield is too good
        GLOBAL_REWARD_LOG_INTERVAL_MS: 60 * 60 * 1000, // 1h
    },

    // 5️⃣ Reward Optimization (Quadratic Scoring)
    REWARD_OPTIMIZATION: {
        USE_LADDER: true,
        MID_TOLERANCE_TICKS: 2, // Only reprice if mid moves > 2 ticks
        LADDER_LEVELS: [
            { distance: 0.005, sizePercent: 0.70 },
            { distance: 0.010, sizePercent: 0.30 }
        ],
        USE_ASYMMETRIC: true,
        ASYMMETRIC_SENSITIVITY: 0.5,
        TIGHTER_SPREAD_MULTIPLIER: 0.3,
    },

    // 6️⃣ Inventory & Capital Efficiency (Phase 2)
    CAPITAL_EFFICIENCY: {
        ENABLE_RECYCLING: true,
        RECYCLE_MAX_TICK_AGE_MS: 10000,
        ENABLE_MERGE: true,
        CONCENTRATION_THRESHOLD: 80,
        MAX_CAPITAL_CONCENTRATION: 2.5, // Increased from 0.90 to 2.5 as per previous walkthrough
    },

    // 7️⃣ Risk & Latency Management (Phase 4)
    RISK_MANAGEMENT: {
        VOLATILITY_WINDOW_MS: 60 * 1000,   // 60 second rolling window
        VOLATILITY_MIN_DATA_POINTS: 10,  // Need some history to calculate
        // Freeze if Volatility > (MaxSpread * VOLATILITY_SENSITIVITY)
        VOLATILITY_SENSITIVITY: 0.33,

        PREDICTIVE_CANCEL_TPS: 5,         // Cancel if > 5 trades/sec
        PREDICTIVE_CANCEL_WINDOW_MS: 3000, // Look back 3s

        ADAPTIVE_SIZING_BASELINE_REWARDS: 50, // Markets with $50 rewards get baseline size
    },

    // 9️⃣ Temporal & Advanced (Phase 5)
    TEMPORAL: {
        GTD_EXPIRY_SECONDS: 1800,          // 30 mins (Increased from 5/2 mins as per user request)
        ENABLE_TEMPORAL_ALPHA: true,
        // Hours (0-23) ET? We'll assume local system time for now.
        // Low activity periods where we are more opportunistic
        LOW_ACTIVITY_HOURS: [1, 2, 3, 4, 5, 6, 7, 8],
        RISK_PROFILE: {
            LOW_ACTIVITY_MULTIPLIER: 1.5,  // Take more risk
            HIGH_ACTIVITY_MULTIPLIER: 0.8, // Pull back during peak vol
        }
    },

    // 🔟 Performance & Dashboard (Phase 6)
    MONITORING_ADVANCED: {
        DASHBOARD_INTERVAL_MS: 5 * 60 * 1000, // Show table every 5 mins
        SCORING_CHECK_INTERVAL_MS: 30 * 1000, // Verify scoring every 30s
    },

    // 1️⃣1️⃣ Global Safety
    SAFETY: {
        MIN_TOTAL_DAILY_REWARDS: 10.0,
    },

    // 8️⃣ Liquidity Pressure (Phase 8)
    LIQUIDITY_PRESSURE: {
        ENABLE_DYNAMIC_DISTANCING: true,
        DEPTH_CHECK_INTERVAL_MS: 5000,
        // Phase 19: Time-to-Consume Model (replaced MIN_DEPTH_USDC)
        TTC_SAFETY_HORIZONS: {
            AGGRESSIVE: 60,   // 60 seconds @ 0.5¢
            MODERATE: 120,    // 120 seconds @ 1.0¢
            DEFENSIVE: 240    // 240 seconds @ 1.5¢
        },
        TRADE_VELOCITY_WINDOW_MS: 30000, // 30s rolling window
        MIN_TRADE_RATE_EPSILON: 0.1, // Fallback for zero-trade markets (very safe)
        DISTANCES: {
            AGGRESSIVE: 0.005, // 0.5¢
            MODERATE: 0.010,   // 1.0¢
            DEFENSIVE: 0.015   // 1.5¢
        },
        HYSTERESIS_CYCLES: 2,   // Cycles to sustain before changing
        REPLENISH_THRESHOLD_USDC_PER_SEC: 1000 // Phase 18: $1000/sec inflow overrides thin depth
    }
};
