import { DipArbConfig } from "../strategies/dipArb.js";

type CoinType = 'BTC' | 'ETH' | 'SOL' | 'XRP';

interface CliArgs {
    coin: CoinType;
    dipThreshold: number;
    slidingWindowMs: number;
    leg2TimeoutSeconds: number;
    sumTarget: number;
    shares: number;
    // windowMinutes removed
    verbose: boolean;
    info: boolean;
    redeem: boolean;
    dashboard: boolean;
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
    // Updated presets based on "Observed behavior" (Steady, Defensive, Opportunistic)
    const coinDefaults: Record<CoinType, Partial<DipArbConfig>> = {
        BTC: {
            dipThreshold: 0.18,        // BTC often dumps 18–22% very fast
            slidingWindowMs: 3000,     // Fast reaction
            leg2TimeoutSeconds: 90,    // BTC mean-reverts quickly
            sumTarget: 0.955,          // Don’t wait for perfection
            shares: 6,                 // Dynamic sizing still applies
            ignorePriceBelow: 0.06
        },

        ETH: {
            dipThreshold: 0.25,        // ETH needs clearer dump
            slidingWindowMs: 4000,     // Filter noise
            leg2TimeoutSeconds: 150,   // Hedge takes longer
            sumTarget: 0.96,           // Defensive
            shares: 5,
            ignorePriceBelow: 0.06
        },

        SOL: {
            // Kept previous SOL defaults or align with ETH? 
            // User didn't specify SOL update, keeping previous safe defaults or matching ETH structure.
            // Previous was similar to ETH.
            dipThreshold: 0.25,
            slidingWindowMs: 4000,
            leg2TimeoutSeconds: 120,
            sumTarget: 0.96,
            shares: 5,
            ignorePriceBelow: 0.06
        },

        XRP: {
            dipThreshold: 0.38,        // Needs absurd move
            slidingWindowMs: 4500,
            leg2TimeoutSeconds: 180,
            sumTarget: 0.97,           // Safety first
            shares: 4,
            ignorePriceBelow: 0.07
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
        // windowMinutes removed
        ignorePriceBelow: getArgValue('min-price', defaults.ignorePriceBelow!), // exposed as --min-price
        verbose: getBoolArg('verbose', false),
        info: args.includes('-info') || args.includes('--info'),
        redeem: args.includes('-redeem') || args.includes('--redeem'),
        dashboard: args.includes('-dashboard') || args.includes('--dashboard'),
        // Strategy Selection
        strategy: (args.includes('--arb') || args.includes('-arb')) ? 'true-arb' : 'dip'
    };
}
