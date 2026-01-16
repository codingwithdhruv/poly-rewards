import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { CONFIG } from "./config.js";

import { providers } from "ethers";

export async function createClobClient(): Promise<ClobClient> {
    const provider = new providers.JsonRpcProvider(CONFIG.RPC_URL);
    const signer = new Wallet(CONFIG.PRIVATE_KEY, provider);
    const chainId = CONFIG.CHAIN_ID || 137;

    console.log(`[ClobClient] Initializing for address: ${signer.address}`);

    // same logic as poly-all-in-one: Init with L1 to get creds, then L2
    const tempClient = new ClobClient(CONFIG.HOST, chainId, signer);
    let apiCreds;

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
        // Gnosis Safe / Proxy Usage
        // import { SignatureType } from "@polymarket/clob-client"; // Removed nested import

        // ...

        return new ClobClient(
            CONFIG.HOST,
            chainId,
            signer,
            apiCreds,
            2, // SignatureType.GnosisSafe
            proxyAddress
        );
    }

    // Standard EOA Usage
    return new ClobClient(
        CONFIG.HOST,
        chainId,
        signer,
        apiCreds
    );
}
