
import { parseArgs } from "node:util";

export interface Args {
    strategy: string;
    dashboard: boolean;
    verbose: boolean;
    custom?: string;
    mid?: string;
    sl?: string;
}

export function parseCliArgs(): Args {
    const options = {
        strategy: {
            type: "string" as const,
            short: "s",
            default: "rewards"
        },
        dashboard: {
            type: "boolean" as const,
            short: "d",
            default: false
        },
        verbose: {
            type: "boolean" as const,
            short: "v",
            default: false
        },
        custom: {
            type: "string" as const,
            short: "c",
        },
        mid: {
            type: "string" as const, // Distance from Mid in Cents (e.g. "2" for 2c)
        },
        sl: {
            type: "string" as const, // Stoploss distance in Cents (e.g. "1" for 1c)
        }
    };

    // @ts-ignore
    const { values } = parseArgs({ options, strict: false });
    return values as Args;
}
