import dotenv from "dotenv";

dotenv.config();

const getEnvParam = (key: string): string => {
    const value = process.env[key];
    if (!value) {
        throw new Error(`${key} is missing in .env file`);
    }
    return value;
};

export const CONFIG = {
    HOST: "https://clob.polymarket.com",
    RELAYER_URL: "https://relayer-v2.polymarket.com/",
    CHAIN_ID: parseInt(process.env.Chain_ID || "137"),
    RPC_URL: getEnvParam("RPC_URL"),
    PRIVATE_KEY: getEnvParam("PRIVATE_KEY"),
    POLY_BUILDER_API_KEY: getEnvParam("BUILDER_API_KEY"),
    POLY_BUILDER_SECRET: getEnvParam("BUILDER_SECRET"),
    POLY_BUILDER_PASSPHRASE: getEnvParam("BUILDER_PASS_PHRASE"),

    // Optional: Proxy / Gnosis Safe Configuration
    // If set, the bot will act as this proxy address
    POLY_PROXY_ADDRESS: process.env.POLY_PROXY_ADDRESS,
};

export const isProxyEnabled = (): boolean => {
    return !!CONFIG.POLY_PROXY_ADDRESS;
}
