# Poly-Addict Bot Manual

A comprehensive guide to running the Poly-Addict bot, detailing all commands, features, and configurations.

## 🚀 Key Commands

### 1. **Run Trading Bot**
Starts the bot for a specific token (Coin). The bot will scan for 15m markets, detect dips, and execute the **Gabagool Gabagool** strategy (Hedged Mean Reversion).

```bash
# Start BTC Bot
./trade btc  # Shorthand for ./trade --btc

# Start ETH Bot
./trade eth  # Shorthand for ./trade --eth

# Start XRP Bot
./trade xrp

# Start SOL Bot
./trade sol
```

### 2. **PnL Dashboard**
Runs a dedicated, live-updating dashboard that monitors the performance of all active bots.
*   **What it does:** Reads shared state from `data/pnl.json` and displays Realized PnL, Open Exposure, and Win/Loss stats.
*   **Usage:** Run this in a separate terminal window alongside your trading bots.

```bash
./trade -dashboard
```

### 3. **Account Information**
Displays your wallet details and exits. Useful for checking balances and proxy configuration before trading.
*   **What it displays:**
    *   EOA (Signer) Address
    *   Proxy Address (if configured)
    *   USDC.e Balance (Collateral)
    *   POL Balance (Gas)

```bash
./trade -info
```

### 4. **Redeem Winnings**
Scans for and redeems all winning positions and merges fully complete sets (YES+NO) back into USDC.e.
*   **What it does:**
    *   Checks for finalized markets where you hold winning shares.
    *   Checks for "Sets" (YES + NO) that can be merged.
    *   Executes redemption transactions (batching them if using a Proxy).

```bash
./trade -redeem
```

---

## ⚙️ Configuration & Flags

You can override default strategy parameters using CLI flags.

### **Common Flags**
| Flag | Description | Example |
| :--- | :--- | :--- |
| `--verbose` | Enable detailed logging of price checks and decisions. | `./trade btc --verbose` |
| `--shares=N` | Initial order size (in shares) per clip. Note: Dynamic sizing (Max 5% of balance) will cap this. | `./trade eth --shares=10` |
| `--dip=N` | Dip threshold % (e.g. 0.18 = 18%). | `./trade btc --dip=0.20` |
| `--target=N` | Sum Target for exit (e.g. 0.96 means exit when Yes+No <= 0.96). | `./trade eth --target=0.98` |
| `--timeout=N` | Leg-2 Timeout in seconds (Force Hedge triggers after this). | `./trade xrp --timeout=120` |

### **Defaults (Optimized per Coin)**
| Coin | Dip Threshold | Timeout (s) | Window (ms) | Sum Target |
| :--- | :--- | :--- | :--- | :--- |
| **BTC** | 18% | 90s | 3000ms | 0.955 |
| **ETH** | 25% | 150s | 4000ms | 0.96 |
| **SOL** | 25% | 120s | 4000ms | 0.96 |
| **XRP** | 38% | 180s | 4500ms | 0.97 |

---

## 🛡️ Safety Features Explained

### **1. Force Hedge (Leg-2 Protection)**
If the bot buys one side (e.g., YES) but the other side (NO) does not dip within the **Timeout** window:
*   The bot **detects the naked position**.
*   It **FORCE BUYS** the opposite side at the *current market price*.
*   It **LOCKS** the pair (Status: `complete`) and stops trading that market.
*   **Benefit:** Converts a potential 100% loss (directional risk) into a controlled, small loss (spread cost).

### **2. Kill Switch**
*   Active on all bots.
*   If your daily drawdown exceeds **5%** of your starting balance, the bot triggers a **FATAL ERROR** and shuts down to protect capital.

### **3. WalletGuard**
*   Prevents "double spending" or race conditions.
*   Reserves funds locally before sending orders.
*   Automatically releases reservations if orders fail.

### **4. Proxy Support (Gnosis Safe)**
*   If `POLY_PROXY_ADDRESS` is set in `.env`, the bot automatically trades on behalf of that Safe.
*   Uses `SignatureType = 2` (Gnosis Safe) for all CLOB orders.

---

## 📂 Setup

Ensure your `.env` file is configured correctly:

```env
PRIVATE_KEY=0x...          # Your EOA (Signer) Key
POLY_PROXY_ADDRESS=0x...   # (Optional) Your Gnosis Safe Address
RPC_URL=...               # Polygon RPC URL
```
