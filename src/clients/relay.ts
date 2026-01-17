import { createWalletClient, http, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";
import { BuilderConfig, BuilderApiKeyCreds } from "@polymarket/builder-signing-sdk";
import { CONFIG } from "./config";

export function createRelayClient(): RelayClient {
    const account = privateKeyToAccount(CONFIG.PRIVATE_KEY as Hex);
    const wallet = createWalletClient({
        account,
        chain: polygon,
        transport: http(CONFIG.RPC_URL)
    });

    const builderConfig = new BuilderConfig({
        localBuilderCreds: {
            key: CONFIG.POLY_BUILDER_API_KEY,
            secret: CONFIG.POLY_BUILDER_SECRET,
            passphrase: CONFIG.POLY_BUILDER_PASSPHRASE
        }
    });

    const client = new RelayClient(
        CONFIG.RELAYER_URL,
        CONFIG.CHAIN_ID,
        wallet,
        builderConfig,
        RelayerTxType.SAFE // Critical fix: Specify TxType
    );

    // Verify Safe exists
    // Note: This needs to be called, but createRelayClient is synchronous factory.
    // We should move this check to initialization or main.
    return client;
}

export async function verifySafeDeployment(provider: any, safeAddress: string) {
    const code = await provider.getCode(safeAddress);
    if (code === "0x") {
        throw new Error(`Safe at ${safeAddress} is not deployed (code=0x)`);
    }
    console.log(`Safe ${safeAddress} verified on-chain.`);
}
