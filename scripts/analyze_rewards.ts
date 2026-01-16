
import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";

const CLOB_HOST = "https://clob.polymarket.com/";

async function main() {
    console.log("Fetching markets...");
    const clobClient = new ClobClient(CLOB_HOST, 137, new ethers.Wallet(ethers.Wallet.createRandom().privateKey));

    // Fetch Rewards
    const rewards = await clobClient.getSamplingMarkets();
    const markets = rewards.data;

    console.log(`Fetched ${markets.length} reward markets.`);

    // Sort by Yield (Rewards / Competition) - Rough Proxy
    // Since we don't have full orderbook here easily, we'll use Rewards as primary and Spread as penalty.
    // Actually, let's just show the Top 20 by Rewards and see their metrics.

    // Filter specifically for the markets the user mentioned to debug them
    const watchList = [
        "Will António José Seguro win",
        "Will Trump nominate Rick Rieder",
        "Will the Iranian regime fall",
        "Billionaire one-time wealth tax"
    ];

    const interesting = markets.filter((m: any) =>
        watchList.some(w => m.question.includes(w)) ||
        (m.rewards?.rates?.[0]?.rewards_daily || 0) > 50
    );

    console.log("\nYield Analysis (High Reward Markets):");
    console.log("Name | Rewards | Spread(¢) | Est.Comp | Yield Score | Tier 1 Check");
    console.log("-".repeat(110));

    for (const m of interesting) {
        const rewardsVal = m.rewards?.rates?.[0]?.rewards_daily || 0;

        const bestBid = Number(m.best_bid) || 0;
        const bestAsk = Number(m.best_ask) || 1;
        const spreadRaw = bestAsk - bestBid;
        const spreadCents = spreadRaw * 100;

        // Estimate Competition (1-5) based on Spread (Proxy)
        // <1¢=5, <3¢=4, <5¢=3, <10¢=2, >10¢=1
        let comp = 1;
        if (spreadCents < 1) comp = 5;
        else if (spreadCents < 3) comp = 4;
        else if (spreadCents < 5) comp = 3;
        else if (spreadCents < 10) comp = 2;

        // Yield Score = Rewards / Competition
        const yieldScore = rewardsVal / comp;

        // Check T1 (Whale: Rew>75, Comp<=4, Spr<=5)
        const isT1 = rewardsVal > 75 && comp <= 4 && spreadCents <= 5;

        console.log(`${m.question.slice(0, 30).padEnd(30)} | $${rewardsVal.toFixed(0).padEnd(7)} | ${spreadCents.toFixed(1)}¢      | ${comp}        | ${yieldScore.toFixed(1).padEnd(11)} | ${isT1 ? "PASS" : "FAIL"}`);
    }
}

main();
