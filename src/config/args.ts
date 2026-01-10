import { DipArbConfig } from "../strategies/dipArb.js";

type CoinType = 'BTC' | 'ETH' | 'SOL' | 'XRP';

interface CliArgs {
    coin: CoinType;
    dipThreshold: number;
    slidingWindowMs: number;
    leg2TimeoutSeconds: number;
    sumTarget: number;
    shares: number;
    windowMinutes: number; // Entry window in minutes
    verbose: boolean;
    info: boolean;
    redeem: boolean;
}

export function parseCliArgs(): DipArbConfig {
    const args = process.argv.slice(2);

    // 1. Parse Coin Type
    let coin: CoinType = 'ETH'; // Default
    if (args.includes('--btc') || args.includes('-b')) coin = 'BTC';
    else if (args.includes('--eth') || args.includes('-e')) coin = 'ETH';
    else if (args.includes('--sol') || args.includes('-s')) coin = 'SOL';
    else if (args.includes('--xrp') || args.includes('-x')) coin = 'XRP';

    // Also check --coin=XYZ
    const coinArg = args.find(a => a.startsWith('--coin='));
    if (coinArg) {
        const val = coinArg.split('=')[1].toUpperCase();
        if (['BTC', 'ETH', 'SOL', 'XRP'].includes(val)) {
            coin = val as CoinType;
        }
    }

    // 2. Define Defaults per Coin
    // Updated presets based on "Scavenger Mode" (Strict, High Profit, Early Entry)
    const coinDefaults: Record<CoinType, Partial<DipArbConfig>> = {
        BTC: {
            dipThreshold: 0.25,       // 25% drop
            slidingWindowMs: 3000,    // 3s (Fast)
            leg2TimeoutSeconds: 90,   // 1.5 min
            sumTarget: 0.92,          // 8% spread
            shares: 8,                // Higher conviction
            windowMinutes: 3,         // Only first 3 mins
            ignorePriceBelow: 0.04    // Ignore cheap option noise
        },
        ETH: {
            dipThreshold: 0.30,       // Stricter than BTC
            slidingWindowMs: 3000,
            leg2TimeoutSeconds: 90,
            sumTarget: 0.92,
            shares: 6,
            windowMinutes: 3,
            ignorePriceBelow: 0.04
        },
        SOL: {
            dipThreshold: 0.30,       // Stricter than BTC
            slidingWindowMs: 3000,
            leg2TimeoutSeconds: 90,
            sumTarget: 0.92,
            shares: 6,
            windowMinutes: 3,
            ignorePriceBelow: 0.04
        },
        XRP: {
            dipThreshold: 0.40,       // Strictest (High Volatility)
            slidingWindowMs: 3000,
            leg2TimeoutSeconds: 90,
            sumTarget: 0.92,
            shares: 6,
            windowMinutes: 3,
            ignorePriceBelow: 0.04
        },
    };

    const defaults = coinDefaults[coin];

    // 3. Helper to parse args
    const getArgValue = (name: string, defaultVal: number): number => {
        // Check --name=VAL
        const arg = args.find(a => a.startsWith(`--${name}=`));
        if (arg) {
            const val = parseFloat(arg.split('=')[1]);
            return isNaN(val) ? defaultVal : val;
        }
        return defaultVal;
    };

    // Helper for boolean flags
    const getBoolArg = (name: string, defaultVal: boolean): boolean => {
        if (args.includes(`--${name}`)) return true;
        const arg = args.find(a => a.startsWith(`--${name}=`));
        if (arg) {
            return arg.split('=')[1].toLowerCase() === 'true';
        }
        return defaultVal;
    };

    // 4. Construct Final Config
    return {
        coin,
        dipThreshold: getArgValue('dip', defaults.dipThreshold!),
        slidingWindowMs: getArgValue('window', defaults.slidingWindowMs!),
        leg2TimeoutSeconds: getArgValue('timeout', defaults.leg2TimeoutSeconds!),
        sumTarget: getArgValue('target', defaults.sumTarget!),
        shares: getArgValue('shares', defaults.shares!),
        windowMinutes: getArgValue('entry-window', defaults.windowMinutes!),
        ignorePriceBelow: getArgValue('min-price', defaults.ignorePriceBelow!), // exposed as --min-price
        verbose: getBoolArg('verbose', false),
        info: args.includes('-info') || args.includes('--info'),
        redeem: args.includes('-redeem') || args.includes('--redeem')
    };
}
