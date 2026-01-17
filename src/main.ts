import { ethers } from "ethers";
import { createClobClient } from "./clients/clob.js";
import { createRelayClient, verifySafeDeployment } from "./clients/relay.js";
import { parseCliArgs } from "./config/args.js";
import { RewardsStrategy } from "./strategies/RewardsStrategy.js";
import { Bot, BotConfig } from "./bot.js";
import { CONFIG } from "./clients/config.js";


// --- UI Helpers for Dashboard ---
const COLORS = {
    RESET: "\x1b[0m",
    BRIGHT: "\x1b[1m",
    DIM: "\x1b[2m",
    RED: "\x1b[31m",
    GREEN: "\x1b[32m",
    YELLOW: "\x1b[33m",
    BLUE: "\x1b[34m",
    MAGENTA: "\x1b[35m",
    CYAN: "\x1b[36m",
    WHITE: "\x1b[37m",
};

function color(text: string, colorCode: string): string {
    return `${colorCode}${text}${COLORS.RESET}`;
}

async function main() {
    const args = parseCliArgs();

    // --- STANDALONE DASHBOARD MODE ---
    if (args.dashboard) {
        console.log("Dashboard removed: Use the poly-rewards bot normally which logs status.");
        return;
    }

    // --- NORMAL BOT MODE ---
    console.log(`Starting Bot...`);

    // 2. Clients
    console.log("Initializing local wallet and relay client...");
    // const wallet = ... (removed manual wallet creation as createRelayClient handles it)
    const relayClient = createRelayClient(); // No args

    if (CONFIG.POLY_PROXY_ADDRESS) {
        // clob client creates provider internally but not exposed easy.
        // use ethers provider from clob creation or make new one.
        const provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
        await verifySafeDeployment(provider, CONFIG.POLY_PROXY_ADDRESS);
    }

    console.log("Initializing CLOB client...");
    const { client: clobClient, creds } = await createClobClient(); // Unpack

    // 3. Strategy
    console.log(`Initializing Rewards Strategy${args.custom ? ` [Custom Mode: "${args.custom}"]` : ""}...`);
    const customSpread = args.mid ? Number(args.mid) / 100 : undefined;
    const customAvoid = args.sl ? Number(args.sl) / 100 : undefined;

    const strategy = new RewardsStrategy(args.custom, customSpread, customAvoid, creds);


    // 4. Bot
    const config: BotConfig = {
        scanIntervalMs: 2000,
        logIntervalMs: 5000
    };

    // 4. Bot

    const bot = new Bot(clobClient, relayClient, strategy, config);
    await bot.start();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});