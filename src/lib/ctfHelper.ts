import { ethers } from "ethers";
import { CONFIG } from "../clients/config.js";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { createWalletClient, http, Hex, encodeFunctionData, parseUnits, getAddress, createPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

// Use lowercase to ensure getAddress() doesn't throw on invalid mixed-case checksum
const CTF_ADDRESS = getAddress("0x4d97dcd97ec945f40cf65f87097ace5ea0476045"); // Polygon CTF (Normalized)
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e on Polygon

// Exchange Addresses for Approvals
const CTF_EXCHANGE_ADDRESS = "0xC5d563A36AE78145C45a50134d48A1215220f80a"; // NegRisk / Multi-Outcome
const LEGACY_CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"; // Binary

const CTF_ABI = [
    "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
    "function setApprovalForAll(address operator, bool approved)",
    "function isApprovedForAll(address owner, address operator) view returns (bool)"
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

/**
 * Ensures that the CTF contract has approved the CTF Exchange to trade the user's tokens.
 * This is CRITICAL for selling positions.
 */
export async function ensureCTFApprovals(relayer?: RelayClient) {
    console.log("[CTF] Checking Approvals for CTF Exchange...");
    const operators = [CTF_EXCHANGE_ADDRESS, LEGACY_CTF_EXCHANGE_ADDRESS];

    // Setup View Client
    const publicClient = createPublicClient({
        chain: polygon,
        transport: http(CONFIG.RPC_URL)
    });

    const owner = CONFIG.POLY_PROXY_ADDRESS || privateKeyToAccount(CONFIG.PRIVATE_KEY as Hex).address;

    const checkApproval = async (operator: string) => {
        try {
            const isApproved = await publicClient.readContract({
                address: CTF_ADDRESS as Hex,
                abi: [{
                    name: "isApprovedForAll",
                    type: "function",
                    inputs: [{ name: "owner", type: "address" }, { name: "operator", type: "address" }],
                    outputs: [{ name: "", type: "bool" }],
                    stateMutability: "view"
                }],
                functionName: "isApprovedForAll",
                args: [owner as Hex, operator as Hex]
            });
            return isApproved;
        } catch (e) {
            console.warn(`[CTF] Failed to check approval for ${operator}:`, e);
            return false;
        }
    };

    for (const operator of operators) {
        const isApproved = await checkApproval(operator);
        if (isApproved) {
            console.log(`[CTF] Operator ${operator} is ALREADY approved.`);
            continue;
        }

        console.log(`[CTF] Operator ${operator} is NOT approved. Sending approval tx...`);

        if (CONFIG.POLY_PROXY_ADDRESS && relayer) {
            const data = encodeFunctionData({
                abi: [{
                    name: 'setApprovalForAll',
                    type: 'function',
                    inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }],
                    stateMutability: 'nonpayable'
                }],
                args: [operator as Hex, true]
            });

            try {
                const tx = await relayer.execute([{
                    to: CTF_ADDRESS as Hex,
                    data: data as Hex,
                    value: "0"
                }]);
                console.log(`[CTF] Approval Sent via Relayer: ${tx.transactionHash}`);
            } catch (e) {
                console.error(`[CTF] Failed to approve via relayer:`, e);
            }

        } else {
            // EOA
            const provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
            const signer = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
            const contract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, signer);
            try {
                const tx = await contract.setApprovalForAll(operator, true);
                console.log(`[CTF] Approval Tx Sent: ${tx.hash}`);
                await tx.wait();
                console.log(`[CTF] Approval Confirmed.`);
            } catch (e) {
                console.error(`[CTF] Failed to approve via EOA:`, e);
            }
        }
    }
}
