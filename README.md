# 🦅 Poly-Addict
> *High-Frequency Prediction Market Trading Suite for Polymarket (Polygon)*

**Poly-Addict** is an institutional-grade algorithmic trading bot engineered for the Polymarket ecosystem. It specializes in volatility harvesting ("The Gabagool") and atomic arbitrage, backed by robust safety mechanisms including WalletGuard™ and Proxy Integration.

---

## 🚀 Features

### 🧠 Strategic Engines
1.  **The Gabagool (Dip Arbitrage)**
    *   **Logic**: Exploits mean-reversion in binary markets. Accumulates heavily when spreads widen (panic dumps) and exits when they normalize.
    *   **Exit Waterfall**:
        1.  **True Arb Exit** (Atomic): Closes both legs if `AskYes + AskNo < 1.00`.
        2.  **Early Profit Lock**: Exits if `Mark-to-Market PnL > 10%`.
        3.  **Late Dominance Exit**: Time-weighted exit if `Dominance > 70%`.
        4.  **Partial Unwind**: Sells winner-only in last 45s to reduce variance.
2.  **True Pair Arb (Atomic)**
    *   **Logic**: Scans for instant risk-free arbitrage opportunities where `AskYes + AskNo < 1.00`.
    *   **Safety**: Executes atomically or rolls back. Zero directional risk.

### 🛡️ Safety Systems
*   **WalletGuard™**: Local semaphore preventing capital over-commitment. Ensures "In-Flight" orders don't exceed wallet capacity.
*   **Force Hedge**: Automatically detects naked positions (failed leg 2). If timeout is reached, it panic-buys the missing leg to neutralize delta, even at a loss.
*   **Drawdown Kill Switch**: Terminates process if session drawdown exceeds 5%.
*   **Proxy Support**: Native integration for Gnosis Safe / Relayer execution (Gasless).

---

## 📦 Installation & Setup

### Prerequisites
*   Node.js v16+ (v20+ recommended)
*   Polygon RPC URL (Alchemy/Infura)
*   Polymarket API Keys (Proxy or EOA)

### 1. clone
```bash
git clone https://github.com/your-username/poly-addict.git
cd poly-addict
```

### 2. Install
```bash
npm install
```

### 3. Environment Config
Create a `.env` file in the root:
```env
# Required: RPC & Private Key
RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=0xYOUR_PRIVATE_KEY

# Optional: Proxy Wallet (Gnosis Safe)
# POLY_PROXY_ADDRESS=0xYOUR_PROXY_ADDRESS
```

---

## 🎮 Quick Start

### 1. Run "The Gabagool" (Dip Buying)
Continuously scans a specific coin market for dumps.

**Basic (ETH)**
```bash
./trade eth
```

**Aggressive (BTC)**
```bash
./trade btc --dip=0.15 --shares=500
```

**Defensive (XRP)**
```bash
./trade xrp --dip=0.40 --target=0.98 --shares=100
```

### 2. Run Atomic Arbitrage
Scans for risk-free arbs on a specific asset.
```bash
./arb sol
```

### 3. Dashboards & Utilities
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

## 🔧 Configuration Flags

| Flag | Description | Default (ETH) | Example |
| :--- | :--- | :--- | :--- |
| **Asset Selection** | | | |
| `--eth`, `--btc`, `--sol` | Selects target asset market | ETH | `./trade --btc` |
| **Strategy Params** | | | |
| `--dip` | Price drop % to trigger buy (0.15 = 15%) | 0.25 | `--dip=0.15` |
| `--target` | Sum Target to exit (AvgYes + AvgNo) | 0.96 | `--target=0.98` |
| `--shares` | Max shares per clip | 5 | `--shares=100` |
| `--timeout` | Leg 2 max wait before Force Hedge (seconds) | 150 | `--timeout=60` |
| `--window` | Sliding window for dip detection (ms) | 4000 | `--window=2000` |
| **Global** | | | |
| `--verbose` | Enable debug logs | false | `--verbose` |
| `--arb` | Switch to Atomic Arb Strategy | false | `--arb` |

---

## 📚 Advanced Architecture

### The "Force Hedge" Mechanism
If the bot accumulates Leg 1 (e.g., YES) but Leg 2 (NO) liquidity dries up, the bot enters a **Naked Position** state.
1.  **Timer Starts**: Configurable via `--timeout` (e.g. 60s).
2.  **Detection**: If Leg 2 is missing after timeout.
3.  **Action**: FORCE BUY Leg 2 at *any* price.
    *   **Bypasses Risk Caps**: Uses 100% of available wallet to neutralize.
    *   **Bypasses WalletGuard**: Overrides safety checks to prioritize survival.

### Partial Late Unwind
Near market expiry (< 45s), if the bot holds a winning position that is dominant (> 70% odds):
1.  **Sells Winner Leg**: Realizes profit immediately.
2.  **Keeps Loser Leg**: Holds as a "free roll" (zero cost basis).
3.  **Lock**: Disables further trading to prevent variance.

---

## ⚠️ Disclaimer
*Prediction markets are volatile. "Risk-free" arbitrage relies on atomic execution which depends on chain stability. Use at your own risk. The authors accept no liability for financial losses.*
