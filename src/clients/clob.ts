import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { CONFIG } from "./config";

import { providers } from "ethers";

// Define interface for return
import { ApiKeyCreds } from "@polymarket/clob-client";

export async function createClobClient(): Promise<{ client: ClobClient, creds: ApiKeyCreds }> {
    const provider = new providers.JsonRpcProvider(CONFIG.RPC_URL);
    const signer = new Wallet(CONFIG.PRIVATE_KEY, provider);
    const chainId = CONFIG.CHAIN_ID || 137;

    console.log(`[ClobClient] Initializing for address: ${signer.address}`);

    // same logic as poly-all-in-one: Init with L1 to get creds, then L2
    const tempClient = new ClobClient(CONFIG.HOST, chainId, signer);
    let apiCreds: ApiKeyCreds;

    try {
        apiCreds = await tempClient.deriveApiKey();
        console.log("Derived existing CLOB API Key.");
    } catch (e) {
        console.log("Derive failed, creating new key...");
        apiCreds = await tempClient.createApiKey();
        console.log("Created new CLOB API Key.");
    }

    // Check if proxy is configured
    const proxyAddress = CONFIG.POLY_PROXY_ADDRESS;

    if (proxyAddress) {
        console.log(`[ClobClient] Using Proxy Address: ${proxyAddress} (SignatureType=2)`);

        const client = new ClobClient(
            CONFIG.HOST,
            chainId,
            signer,
            apiCreds,
            2, // SignatureType.GnosisSafe
            proxyAddress
        );
        return { client, creds: apiCreds };
    }

    // Standard EOA Usage
    const client = new ClobClient(
        CONFIG.HOST,
        chainId,
        signer,
        apiCreds
    );
    return { client, creds: apiCreds };
}
