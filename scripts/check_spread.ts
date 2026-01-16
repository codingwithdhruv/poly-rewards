
import { createClobClient } from "../src/clients/clob";
import { GammaClient } from "../src/clients/gamma-api";

async function main() {
    console.log("Initializing clients...");
    const clob = await createClobClient();
    const gamma = new GammaClient();

    // Hardcoded query from user request
    const query = "S&P 500 (SPX) Up or Down on January 16";

    console.log(`Searching Gamma for "${query}"...`);
    // Relaxed search: Just query, no active/closed filters
    const markets = await gamma.getMarkets(`q=${encodeURIComponent(query)}`);

    if (markets.length === 0) {
        console.log("No markets found via Gamma Search.");
        return;
    }

    console.log(`Found ${markets.length} potential matches.`);
    // Basic filter to find best match
    const m = markets.find(m => m.question.includes("S&P 500")) || markets[0];

    console.log(`Selected Market: "${m.question}"`);
    console.log(`Condition ID: ${m.conditionId}`);

    // Fetch Details from CLOB to get Token IDs
    const details = await clob.getMarket(m.conditionId);
    if (!details) {
        console.log("CLOB getMarket returned null.");
        return;
    }

    const yesToken = details.tokens.find((t: any) => t.outcome === "Yes");
    if (!yesToken) {
        console.log("Could not find YES token.");
        return;
    }

    const yesTokenId = yesToken.token_id;
    console.log(`YES Token ID: ${yesTokenId}`);
    console.log("Fetching Orderbook...");

    const ob = await clob.getOrderBook(yesTokenId);

    const bestBid = ob.bids.length > 0 ? Number(ob.bids[0].price) : 0;
    const bestAsk = ob.asks.length > 0 ? Number(ob.asks[0].price) : 0;
    const mid = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;

    console.log("\n====== LIVE MARKET DATA ======");
    console.log(`Market:   ${m.question}`);
    console.log(`Best Bid: ${bestBid.toFixed(2)}`);
    console.log(`Best Ask: ${bestAsk.toFixed(2)}`);
    console.log(`Midpoint: ${mid.toFixed(3)}`);
    console.log(`Spread:   ${spread.toFixed(3)} ($${spread.toFixed(2)})`);
    console.log("==============================");
}

main().catch(console.error);
