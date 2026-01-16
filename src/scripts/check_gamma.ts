
const GAMMA_API_URL = "https://gamma-api.polymarket.com";

interface GammaMarket {
    id: string;
    question: string;
    active: boolean;
    closed: boolean;
    clob_token_ids: string[];
}

interface GammaEvent {
    id: string;
    title: string;
    markets: GammaMarket[];
}

export class GammaClient {
    async getEvents(queryParams: string): Promise<GammaEvent[]> {
        const url = `${GAMMA_API_URL}/events?${queryParams}`;
        console.log(`Fetching Gamma Events: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Gamma API Error: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    }
}

async function main() {
    const client = new GammaClient();
    try {
        console.log("Fetching events (limit 100)...");
        const events = await client.getEvents("active=true&closed=false&limit=100");

        for (const e of events) {
            for (const m of e.markets) {
                if (m.active && !m.closed && m.clob_token_ids && m.clob_token_ids.length >= 2) {
                    console.log("FOUND ACTIVE Market!");
                    console.log("ID:", m.id);
                    console.log("Question:", m.question);
                    console.log("clobTokenIds:", JSON.stringify(m.clob_token_ids));
                    return;
                }
            }
        }
        console.log("No active market found? Impossible.");
    } catch (error) {
        console.error("Error:", error);
    }
}

main();
