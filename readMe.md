# 🦅 Poly-Addict
> *High-Frequency Prediction Market Trading Suite for Polymarket*

**Poly-Addict** is a professional-grade algorithmic trading bot designed for the Polymarket ecosystem. It features volatility-harvesting strategies, atomic arbitrage capabilities, and institutional-grade safety mechanisms custom-built for Polygon prediction markets.

---

## 🚀 Features

### 🧠 Core Strategies
*   **Gabagool (Dip Arbitrage)**: A mean-reversion strategy that captures value during temporary market dislocations (dips). Accumulates positions at discount and exits via:
    *   **Sum Target**: Profit taking when `Yes + No` spreads normalize.
    *   **Early Exit**: Atomic profit locking when mark-to-market PnL > 10% (Exit Value > Entry Cost).
    *   **Late Dominance Exit**: Time-weighted exit at T-60s to avoid expiry variance.
*   **True Pair Arb (Atomic)**: A risk-free arbitrage engine that exploits negative spreads (`AskYes + AskNo < 1.00`). Uses atomic execution sequences with rollback protection.

### 🛡️ Safety Systems
*   **WalletGuard™**: Local semaphore preventing capital over-commitment across concurrent strategies.
*   **Force Hedge**: Automatically detects and neutralizes naked positions if the second leg fails to fill within a timeout.
*   **Daily Kill Switch**: Terminates operation if session drawdown exceeds 5%.
*   **Gnosis Safe Support**: Native integration for trading via Proxy Wallets (Gasless Relayer).

---

## 📦 Installation

### Prerequisites
*   Node.js v16+ (v20+ recommended)
*   Polygon RPC URL (Alchemy/Infura)
*   Polymarket API Keys (EOA Private Key or Proxy Key)

### Setup
1.  **Clone the Repository**
    ```bash
    git clone https://github.com/your-username/poly-addict.git
    cd poly-addict
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    # or
    yarn install
    ```

3.  **Configure Environment**
    Create a `.env` file in the root directory:
    ```env
    # Blockchain
    RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
    PRIVATE_KEY=0xYOUR_PRIVATE_KEY
    
    # Optional: Proxy Wallet (Gnosis Safe)
    # POLY_PROXY_ADDRESS=0xYOUR_PROXY_ADDRESS
    ```

---

## 🎮 Usage

### 1. Dip Arbitrage ("The Gabagool")
Continuously trades a specific market (Coin) looking for dips.

```bash
# Basic Usage (Default Config)
./trade btc

# Advanced Usage (Aggressive)
./trade eth --dip=0.15 --shares=500 --target=0.98
```

### 2. Atomic Arbitrage (Zero Risk)
Scans for risk-free arbitrage opportunities on a specific asset.

```bash
./arb sol
```

### 3. Utilities

**Live PnL Dashboard**
```bash
./trade -dashboard
```

**Check Wallet Balances**
```bash
./trade -info
```

**Redeem Winnings**
```bash
./trade -redeem
```

---

## 📚 Documentation
For detailed architecture, configuration flags, and deep-dive logic explanations, please refer to the **[User Manual](./manual.md)**.

---

## ⚠️ Disclaimer
*This software is for educational purposes only. Prediction market trading involves significant risk. The authors are not responsible for financial losses incurred while using this software. Use at your own risk.*
