# 🦅 Poly-Addict
> *High-Frequency Prediction Market Trading Suite for Polymarket (Polygon)*

**Poly-Addict** is an institutional-grade algorithmic trading bot engineered for the Polymarket ecosystem. It specializes in volatility harvesting ("The Gabagool") and atomic arbitrage, backed by robust safety mechanisms including WalletGuard™ and Proxy Integration.

---

## 🚀 Features

### 🧠 Strategic Engines
1.  **The Gabagool (Dip Arbitrage)**
    *   **Logic**: Exploits mean-reversion in binary markets. Accumulates heavily when spreads widen (panic dumps) and exits when they normalize.
    *   **Dynamic Entry**: Sliding window analysis (default 3s) detects rapid price drops.
    *   **Exit Waterfall**:
        1.  **Sum Target Exit**: Closes both legs if `AskYes + AskNo <= Target` (e.g. 0.95).
        2.  **Early Profit Lock**: Exits if `Mark-to-Market PnL > 10%`.
        3.  **Late Dominance Exit**: Time-weighted exit if `Dominance > 70%` near expiry.
        4.  **Partial Unwind**: Sells winner-only in last 45s to reduce risk while keeping upside.

2.  **True Pair Arb (Atomic)**
    *   **Logic**: Scans for instant risk-free arbitrage opportunities where `AskYes + AskNo < 1.00`.
    *   **Safety**: Executes atomically or rolls back. Zero directional risk.

### 🛡️ Safety Systems (Battle-Tested)
*   **WalletGuard™**: Local semaphore preventing capital over-commitment. Ensures "In-Flight" orders don't exceed wallet capacity.
*   **Tiered Risk Management**:
    *   **Exposure Cap**: Max **15%** of wallet per market (Standard) / **50%** (Micro).
    *   **Daily Drawdown**: Auto-shutdown if loss exceeds limit.
        *   Micro (<$50): **50%**
        *   Small (<$100): **25%**
        *   Standard (>$100): **10%**
*   **Force Hedge**: Automatically detects naked positions (failed leg 2). If timeout is reached, it panic-buys the missing leg to neutralize delta, even at a loss.
*   **Cycle Resumption**: Smartly detects orphaned cycles on restart, re-attaches if active, or cleans up if expired.
*   **Proxy Support**: Native integration for Gnosis Safe / Relayer execution (Gasless).

---

## 📦 Installation & Setup

### Prerequisites
*   Node.js v16+ (v20+ recommended)
*   Polygon RPC URL (Alchemy/Infura)
*   Polymarket API Keys (Proxy or EOA)

### 1. Clone
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
# POLY_CLOB_API_KEY=...
# POLY_CLOB_SECRET=...
# POLY_CLOB_PASSPHRASE=...
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
**Check Wallet Balances (EOA & Proxy)**
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
| `--shares` | Max shares per clip (subject to Risk Cap) | 5 | `--shares=100` |
| `--timeout` | Leg 2 max wait before Force Hedge (seconds) | 60 | `--timeout=45` |
| `--window` | Sliding window for dip detection (ms) | 3000 | `--window=2000` |
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

### Liability-Based Sizing
Risk is calculated based on **Total Liability ($1.00/share)**, not cost basis.
*   **Cap**: 15% of Wallet (Standard) / 50% (Micro).
*   **Min Size**: Automatically fetches and respects market-specific minimum order sizes (e.g. 5 shares).

### State Machine Hardening
*   **Strict Transitions**: `scanning` -> `complete` guards prevent infinite loops.
*   **Auto-Cleanup**: Expired markets with 0 shares are cleanly removed from tracking.
*   **Resumption**: Bot remembers its positions across restarts and re-attaches to live markets.

---

## ⚠️ Disclaimer
*Prediction markets are volatile. "Risk-free" arbitrage relies on atomic execution which depends on chain stability. Use at your own risk. The authors accept no liability for financial losses.*
