import { ethers } from "ethers";
import { CONFIG } from "../clients/config.js";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { createWalletClient, http, Hex, encodeFunctionData, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const CTF_ADDRESS = "0x4D97DCd97eC945f40cf65F87097ACe5EA0476045"; // Polygon CTF (EIP-55 checksummed)
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e on Polygon (already correct)

const CTF_ABI = [
    "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)"
];

/**
 * Utility to merge YES and NO positions back into USDC
 */
export async function mergePositions(
    conditionId: string,
    amount: number,
    relayer?: RelayClient
): Promise<string> {
    const amountWei = ethers.utils.parseUnits(amount.toFixed(6), 6);
    const partition = [1, 2]; // Partition for YES (1) and NO (2) in standard CTF
    const parentCollectionId = ethers.constants.HashZero;

    if (CONFIG.POLY_PROXY_ADDRESS && relayer) {
        console.log(`[CTF] Merging via Relayer for Proxy: ${CONFIG.POLY_PROXY_ADDRESS}`);

        // Encode function data using viem for relayer
        const data = encodeFunctionData({
            abi: [
                {
                    name: 'mergePositions',
                    type: 'function',
                    stateMutability: 'nonpayable',
                    inputs: [
                        { name: 'collateralToken', type: 'address' },
                        { name: 'parentCollectionId', type: 'bytes32' },
                        { name: 'conditionId', type: 'bytes32' },
                        { name: 'partition', type: 'uint256[]' },
                        { name: 'amount', type: 'uint256' }
                    ]
                }
            ],
            args: [USDC_ADDRESS, parentCollectionId as Hex, conditionId as Hex, [1n, 2n], BigInt(amountWei.toString())]
        });

        // Use relayer to send transaction from Safe
        const response = await relayer.execute([{
            to: CTF_ADDRESS as Hex,
            data: data as Hex,
            value: "0"
        }]);

        console.log(`[CTF] Relayer response:`, response);
        return response.transactionHash;
    } else {
        // EOA path using ethers
        console.log(`[CTF] Merging directly via EOA`);
        const provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
        const signer = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
        const contract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, signer);

        const tx = await contract.mergePositions(
            USDC_ADDRESS,
            parentCollectionId,
            conditionId,
            partition,
            amountWei
        );

        console.log(`[CTF] Transaction sent: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`[CTF] Transaction confirmed: ${receipt.transactionHash}`);
        return receipt.transactionHash;
    }
}
