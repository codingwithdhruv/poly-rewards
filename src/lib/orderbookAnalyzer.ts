/**
 * Orderbook Liquidity Analyzer
 * 
 * Measures orderbook depth and imbalance to enable asymmetric quoting
 */

export interface LiquidityMetrics {
    bidDepth: number;      // Total size within range of mid (bid side)
    askDepth: number;      // Total size within range of mid (ask side)
    imbalance: number;     // askDepth / bidDepth (>1 = more asks, <1 = more bids)
    bidLiquidity: number;  // Inverse of bidDepth (for distance scaling)
    askLiquidity: number;  // Inverse of askDepth (for distance scaling)
}

export interface OrderbookSide {
    price: string;
    size: string;
}

export interface Orderbook {
    bids: OrderbookSide[];
    asks: OrderbookSide[];
}

/**
 * Analyze orderbook liquidity within a specified range from mid
 * 
 * @param orderbook - Orderbook data with bids and asks
 * @param mid - Current midpoint price
 * @param range - Distance from mid to measure (default: 0.01 = 1¢)
 * @returns Liquidity metrics
 */
export function analyzeLiquidity(
    orderbook: Orderbook,
    mid: number,
    range: number = 0.01
): LiquidityMetrics {
    // Calculate bid depth (within range below mid)
    const bidDepth = orderbook.bids
        .filter(b => Number(b.price) >= mid - range)
        .reduce((sum, b) => sum + Number(b.size), 0);

    // Calculate ask depth (within range above mid)
    const askDepth = orderbook.asks
        .filter(a => Number(a.price) <= mid + range)
        .reduce((sum, a) => sum + Number(a.size), 0);

    // Calculate imbalance ratio
    const imbalance = askDepth / (bidDepth || 1);

    // Calculate inverse liquidity (for distance scaling)
    // Lower depth = higher value = quote closer
    const bidLiquidity = bidDepth > 0 ? 1 / bidDepth : 1;
    const askLiquidity = askDepth > 0 ? 1 / askDepth : 1;

    return {
        bidDepth,
        askDepth,
        imbalance,
        bidLiquidity,
        askLiquidity
    };
}

/**
 * Calculate asymmetric distance adjustments based on liquidity imbalance
 * 
 * @param baseDistance - Base distance from mid
 * @param metrics - Liquidity metrics from analyzeLiquidity
 * @param sensitivity - How much to adjust (0-1, default: 0.5)
 * @returns Adjusted distances for bid and ask sides
 */
export function calculateAsymmetricDistances(
    baseDistance: number,
    metrics: LiquidityMetrics,
    sensitivity: number = 0.5
): { bidDistance: number; askDistance: number } {
    // Normalize liquidity values to prevent extreme adjustments
    const maxAdjustment = 2.0; // Max 2x adjustment
    const minAdjustment = 0.5; // Min 0.5x adjustment

    // Calculate adjustment factors
    let bidAdjustment = 1 + (metrics.bidLiquidity * sensitivity);
    let askAdjustment = 1 + (metrics.askLiquidity * sensitivity);

    // Clamp adjustments
    bidAdjustment = Math.max(minAdjustment, Math.min(maxAdjustment, bidAdjustment));
    askAdjustment = Math.max(minAdjustment, Math.min(maxAdjustment, askAdjustment));

    return {
        bidDistance: baseDistance * bidAdjustment,
        askDistance: baseDistance * askAdjustment
    };
}

/**
 * Determine if orderbook is balanced enough for symmetric quoting
 * 
 * @param metrics - Liquidity metrics
 * @param threshold - Imbalance threshold (default: 0.3 = 30% difference)
 * @returns True if balanced, false if asymmetric quoting recommended
 */
export function isBalanced(
    metrics: LiquidityMetrics,
    threshold: number = 0.3
): boolean {
    // Check if imbalance is within threshold
    const deviation = Math.abs(metrics.imbalance - 1.0);
    return deviation <= threshold;
}

/**
 * Get recommended quoting strategy based on liquidity analysis
 * 
 * @param orderbook - Orderbook data
 * @param mid - Current midpoint
 * @param baseDistance - Base distance from mid
 * @param sensitivity - Asymmetric adjustment sensitivity
 * @returns Strategy recommendation
 */
export function getQuotingStrategy(
    orderbook: Orderbook,
    mid: number,
    baseDistance: number,
    sensitivity: number = 0.5
): {
    strategy: 'symmetric' | 'asymmetric';
    metrics: LiquidityMetrics;
    distances?: { bidDistance: number; askDistance: number };
} {
    const metrics = analyzeLiquidity(orderbook, mid);

    if (isBalanced(metrics)) {
        return {
            strategy: 'symmetric',
            metrics
        };
    }

    const distances = calculateAsymmetricDistances(baseDistance, metrics, sensitivity);

    return {
        strategy: 'asymmetric',
        metrics,
        distances
    };
}

// Phase 8: Liquidity Pressure - Depth Band Analysis
export interface DepthBands {
    layer1: number; // Size within 0.5¢
    layer2: number; // Size within 1.0¢
    layer3: number; // Size within 1.5¢
}

/**
 * Analyze orderbook depth bands for liquidity pressure detection
 * 
 * @param orderbook - Orderbook data
 * @param mid - Current midpoint price
 * @returns Depth bands for bids (our side) and asks (counter side) relative to mid
 */
export function analyzeDepthBands(orderbook: Orderbook, mid: number): { bids: DepthBands, asks: DepthBands } {
    const result = {
        bids: { layer1: 0, layer2: 0, layer3: 0 },
        asks: { layer1: 0, layer2: 0, layer3: 0 }
    };

    if (!orderbook || !orderbook.bids || !orderbook.asks) return result;

    // BIDS (Buy Side)
    for (const bid of orderbook.bids) {
        const price = Number(bid.price);
        const dist = Math.abs(mid - price);
        const size = Number(bid.size);
        const value = size * price; // Approx USDC value

        // Using slight buffers to catch floating point edge cases
        if (dist <= 0.0055) { // 0.5c
            result.bids.layer1 += value;
            result.bids.layer2 += value;
            result.bids.layer3 += value;
        } else if (dist <= 0.0105) { // 1.0c
            result.bids.layer2 += value;
            result.bids.layer3 += value;
        } else if (dist <= 0.0155) { // 1.5c
            result.bids.layer3 += value;
        }
    }

    // ASKS (Sell Side)
    for (const ask of orderbook.asks) {
        const price = Number(ask.price);
        const dist = Math.abs(price - mid);
        const size = Number(ask.size);
        const value = size * price; // Approx USDC value

        if (dist <= 0.0055) { // 0.5c
            result.asks.layer1 += value;
            result.asks.layer2 += value;
            result.asks.layer3 += value;
        } else if (dist <= 0.0105) { // 1.0c
            result.asks.layer2 += value;
            result.asks.layer3 += value;
        } else if (dist <= 0.0155) { // 1.5c
            result.asks.layer3 += value;
        }
    }

    return result;
}
