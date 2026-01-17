/**
 * Quadratic Scoring Calculator for Polymarket Rewards
 * 
 * Implements the official Polymarket scoring formula:
 * S(v,s) = ((v-s)/v)² × size
 * 
 * Where:
 * - v = rewardsMaxSpread (max allowed spread)
 * - s = actual distance from mid
 * - size = order size
 */

export interface ScoringParams {
    distance: number;      // Distance from mid (e.g., 0.005 = 0.5¢)
    maxSpread: number;     // rewardsMaxSpread (e.g., 0.03 = 3¢)
    size: number;          // Order size
}

export interface RewardDensityResult {
    score: number;         // Raw scoring value
    density: number;       // Reward per unit of fill risk
    efficiency: number;    // Percentage of max possible score (0-1)
}

/**
 * Calculate reward score using Polymarket's quadratic formula
 * 
 * @param params - Scoring parameters
 * @returns Raw score value
 */
export function calculateScore(params: ScoringParams): number {
    const { distance, maxSpread, size } = params;

    // Validate inputs
    if (distance < 0 || maxSpread <= 0 || size <= 0) {
        return 0;
    }

    if (distance > maxSpread) {
        return 0; // Outside rewards zone
    }

    // S(v,s) = ((v-s)/v)² × size
    const normalizedDist = (maxSpread - distance) / maxSpread;
    return Math.pow(normalizedDist, 2) * size;
}

/**
 * Calculate reward density (reward per unit of fill risk)
 * 
 * Higher density = better risk-adjusted returns
 * 
 * @param params - Scoring parameters
 * @returns Comprehensive reward density metrics
 */
export function calculateRewardDensity(params: ScoringParams): RewardDensityResult {
    const score = calculateScore(params);

    // Fill risk is inversely proportional to distance
    // Closer to mid = higher fill probability
    const fillRisk = params.distance > 0 ? 1 / params.distance : Infinity;

    // Reward density = score / fill risk
    const density = fillRisk !== Infinity ? score / fillRisk : 0;

    // Calculate efficiency (percentage of max possible score)
    const maxScore = calculateScore({
        distance: 0,
        maxSpread: params.maxSpread,
        size: params.size
    });
    const efficiency = maxScore > 0 ? score / maxScore : 0;

    return {
        score,
        density,
        efficiency
    };
}

/**
 * Find optimal distance for maximum reward density
 * 
 * Uses gradient descent to find the sweet spot between
 * high score and low fill risk
 * 
 * @param maxSpread - Maximum allowed spread
 * @param size - Order size
 * @param minDistance - Minimum distance to consider (default: 0.001)
 * @returns Optimal distance from mid
 */
export function findOptimalDistance(
    maxSpread: number,
    size: number,
    minDistance: number = 0.001
): number {
    let bestDistance = minDistance;
    let bestDensity = 0;

    // Test distances from minDistance to maxSpread
    const steps = 100;
    const increment = (maxSpread - minDistance) / steps;

    for (let i = 0; i <= steps; i++) {
        const distance = minDistance + (i * increment);
        const result = calculateRewardDensity({ distance, maxSpread, size });

        if (result.density > bestDensity) {
            bestDensity = result.density;
            bestDistance = distance;
        }
    }

    return bestDistance;
}

/**
 * Compare multiple ladder levels and return metrics
 * 
 * @param levels - Array of distance/size pairs
 * @param maxSpread - Maximum allowed spread
 * @returns Array of results for each level
 */
export function compareLadderLevels(
    levels: Array<{ distance: number; size: number }>,
    maxSpread: number
): RewardDensityResult[] {
    return levels.map(level =>
        calculateRewardDensity({
            distance: level.distance,
            maxSpread,
            size: level.size
        })
    );
}

/**
 * Calculate aggregate score for a multi-level ladder
 * 
 * @param levels - Array of distance/size pairs
 * @param maxSpread - Maximum allowed spread
 * @returns Total combined score
 */
export function calculateLadderScore(
    levels: Array<{ distance: number; size: number }>,
    maxSpread: number
): number {
    return levels.reduce((total, level) => {
        return total + calculateScore({
            distance: level.distance,
            maxSpread,
            size: level.size
        });
    }, 0);
}
