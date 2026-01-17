import { ClobClient } from "@polymarket/clob-client";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { Strategy } from "./strategies/types";

export interface BotConfig {
    scanIntervalMs: number;
    logIntervalMs: number;
}

export class Bot {
    private clobClient: ClobClient;
    private relayClient: RelayClient;
    private strategy: Strategy;
    private config: BotConfig;

    constructor(clobClient: ClobClient, relayClient: RelayClient, strategy: Strategy, config: BotConfig) {
        this.clobClient = clobClient;
        this.relayClient = relayClient;
        this.strategy = strategy;
        this.config = config;
    }

    async start() {
        try {
            console.log("Starting Bot wrapper...");

            // Strategy Init
            // We pass the clients we already created in main.ts
            // Note: Some strategies might expect to create their own clients if none passed?
            // But DipArbStrategy.init(clob, relay) expects them.

            console.log("Initializing strategy...");
            await this.strategy.init(this.clobClient, this.relayClient);

            console.log("Running strategy...");
            await this.strategy.run();

            // Handle graceful shutdown
            process.on('SIGINT', async () => {
                console.log("\nStopping bot...");
                await this.strategy.cleanup();
                process.exit(0);
            });

        } catch (error) {
            console.error("Fatal error starting bot:", error);
            process.exit(1);
        }
    }
}
