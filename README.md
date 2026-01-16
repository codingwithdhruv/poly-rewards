# 💰 Poly Rewards Bot

A sophisticated, thesis-driven market making bot designed for **Polymarket Rewards Farming**. This bot focuses on "High Yield" opportunities, providing deep liquidity to reward-eligible markets while adhering to strict risk and scoring protocols.

---

## 🚀 Key Strategies & Features

### 🧠 Logic & Scoring
- **Yield Score Prioritization**: Markets are ranked by `Yield Score = DailyRewards / Competition`.
  - The bot prioritizes markets where you get the "Most Rewards per Unit of Competition".
- **Strict Tier 1 Focus**:
  - Filters for "Tier 1" candidates (High Yield, Reasonable Spread).
  - Skips "Tier 2/3" (Low Yield/Sniper) markets to maximize capital efficiency.
- **Official API Midpoint**: 
  - Uses `clobClient.getMidpoint()` instead of Orderbook estimation.
  - Ensures quotes are aligned **exactly** with the Rewards Engine's reference price.

### 🎯 Custom Market Targeting (New)
The bot supports a powerful **Custom Mode** to target *any* market, bypassing standard filters.
```bash
./trade -custom "S&P 500" --mid 2 --sl 1
```
- **Unrestricted Access**: Bypasses `DailyRewards`, `Tier`, and `Resolution` checks. If you name it, the bot trades it.
- **Smart Search**: If the market isn't in the standard rewards list, the bot searches the **Gamma API**, fetches CLOB details, and patches missing data (like Question strings) automatically.
- **Custom Spreads**:
  - `--mid X`: Places limit orders at `Mid +/- X` cents (Default: 1c).
  - `--sl Y`: **Stoploss/Avoidance**. If price moves within `Y` cents of your order, it cancels.

### 🛡️ Risk Management & Safeguards
- **Fill Avoidance (Trailling Stop)**:
  - Continuously monitors the "Distance to Mid".
  - If the market moves against you (distance < `--sl` threshold), the bot **Cancels ALL Orders** on that market immediately.
  - *Rule*: "If one side is threatened, close both." This prevents adverse selection on the resting leg.
- **Pre-Trade Balance Checks**:
  - **Collateral (USDC)**: Checks if you have enough funds *before* placing orders.
  - **Shares (YES/NO)**: Checks if you actually own shares *before* attempting to SELL. Prevents "Insufficient Funds" errors.
- **Dual-Sided Budgeting**:
  - Calculates `Total Cost = (YesBid * Size) + (NoBid * Size)`.
  - If `Total Cost > Balance`, it automatically **scales down** the order size.
  - Ensures you always quote both sides (Delta Neutral) rather than being left with one naked leg.

### 📊 UI & Observability
- **Live Progress Counter**: A clean, overwriting counter (`Processing markets... 450/1000`) during scans.
- **Granular Cost Table**:
  - Displays `YesPx`, `NoPx`, `YCost` (Cost for Yes), `NCost` (Cost for No), and `TotCost` (Delta Neutral Total).
  - Gives instant visibility into the capital required to hold a Delta Neutral position.
- **Debug Logging**:
  - Custom Mode prints detailed match info (Rewards, Tokens, EndDate).
  - Explicitly confirms API data integrity (`[Custom Debug] Added...`).

---

## 🛠️ Setup Guide

### 1. Prerequisites
- **Node.js** (v18+)
- **Gnosis Safe Proxy**: Required for gasless trading (Relayer).
- **Polymarket API Keys**: For Proxy/Signer.

### 2. Installation
```bash
git clone <repo-url>
cd poly-rewards
npm install
```

### 3. Environment Variables
Create a `.env` file:
```env
PRIVATE_KEY=your_private_key
BUILDER_API_KEY=your_key
BUILDER_SECRET=your_secret
BUILDER_PASS_PHRASE=your_passphrase
POLY_PROXY_ADDRESS=0xYourProxyAddress
Chain_ID=137
DRY_RUN=false
```

---

## ⚙️ Configuration
Configure `src/config/rewardsConfig.ts`:

### **Allocation**
```typescript
ALLOCATION: {
    MAX_DEPLOYED_PERCENT: 0.80,  // Use 80% of balance
    PER_MARKET_PERCENT: 0.80,    // Allocate heavily to top picks
    MAX_ACTIVE_MARKETS: 1        // Focus on 1 high-yield market (Configurable)
}
```

### **Market Filters (Tier 1)**
```typescript
TIER_1: {
    MIN_YIELD_SCORE: 50,         // High Rewards/Comp ratio
    MIN_DAILY_REWARDS: 50,       // Minimum pool size
    MIN_SHARES_TARGET: 500       // Liquidity depth target
}
```

---

## 🏃‍♂️ Usage

### **1. Standard Auto-Farming**
Runs the strategy on the best available Reward Markets.
```bash
./trade
```

### **2. Custom Market Mode**
Force the bot to trade a specific market with custom risk parameters.
```bash
./trade -custom "Market Name" --mid 2 --sl 1
```
- `-custom`: Search query (Case-insensitive).
- `--mid 2`: Target Spread = 2 cents from Mid.
- `--sl 1`: Cancel if price moves within 1 cent.

---

## 📂 Architecture
- **`RewardsStrategy.ts`**: Core logic.
  - `scanAndRotate()`: Yield Scoring, Gamma Search, Data Patching.
  - `manageMarketOrders()`: Start/Cancel Orders, Budgeting.
  - `runFillAvoidance()`: Stoploss Logic.
- **`marketUtils.ts`**: Tier logic helpers.
- **`gamma-api.ts`**: Data fetching & Search.

## 📜 License
MIT
