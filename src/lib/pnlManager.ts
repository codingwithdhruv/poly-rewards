import fs from 'fs';
import path from 'path';

export interface CoinPnL {
    coin: 'BTC' | 'ETH' | 'XRP' | 'SOL';

    // Capital
    // We might not know "startingBalance" perfectly if multiple coins share a wallet, 
    // but we can track "allocations" or just global PnL. 
    // For simplicity, we just track accumulated PnL and current exposure.

    // Trades
    cyclesCompleted: number;
    cyclesWon: number;
    cyclesLost: number;
    cyclesAbandoned: number;

    // Profit
    realizedPnL: number;

    // Risk
    maxDrawdown: number; // Lowest negative PnL seen? Or dip from high?
    currentExposure: number;
    avgCycleDuration: number; // seconds
}

export interface CycleStats {
    id: string; // Market ID or Slug
    coin: string;
    startTs: number;
    yesCost: number;
    noCost: number;
    status: 'OPEN' | PnlReason;
}

export type PnlReason = 'WIN' | 'LOSS' | 'ABANDON' | 'EARLY_EXIT' | 'LATE_EXIT' | 'ARB';

interface GlobalState {
    coins: Record<string, CoinPnL>;
    activeCycles: Record<string, CycleStats>; // marketId -> stats
    walletBalance: number; // Last seen wallet balance
    startingBalance: number; // Session start balance (or first see)
    lastUpdate: number;
}

const DB_PATH = path.resolve('data/pnl.json');

export class PnlManager {
    private state: GlobalState;

    constructor() {
        this.state = this.load();
    }

    private load(): GlobalState {
        try {
            if (fs.existsSync(DB_PATH)) {
                return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
            }
        } catch (e) {
            console.error("Failed to load PnL DB, resetting:", e);
        }
        return {
            coins: {},
            activeCycles: {},
            walletBalance: 0,
            startingBalance: 0,
            lastUpdate: Date.now()
        };
    }

    private save() {
        this.state.lastUpdate = Date.now();
        fs.writeFileSync(DB_PATH, JSON.stringify(this.state, null, 2));
    }

    public sync() {
        // Reload from disk to get updates from other processes
        const diskState = this.load();
        // Merge? Or just override if we trust disk is source of truth for OTHER coins?
        // Actually, simpler: We only write OUR coin's updates.
        // We should always load before write.
        // But for "Get View", we just load.
        this.state = diskState;
    }

    public updateWalletBalance(bal: number) {
        this.sync();
        this.state.walletBalance = bal;
        if (this.state.startingBalance === 0 && bal > 0) {
            this.state.startingBalance = bal;
        }
        this.save();
    }

    public checkDrawdown(limitPct: number): boolean {
        this.sync();
        if (this.state.startingBalance <= 0) return false;
        const drop = (this.state.startingBalance - this.state.walletBalance) / this.state.startingBalance;
        return drop > limitPct;
    }

    public getCoinStats(coin: string): CoinPnL {
        this.sync(); // ensure freshness
        if (!this.state.coins[coin]) {
            this.state.coins[coin] = {
                coin: coin as any,
                cyclesCompleted: 0,
                cyclesWon: 0,
                cyclesLost: 0,
                cyclesAbandoned: 0,
                realizedPnL: 0,
                maxDrawdown: 0,
                currentExposure: 0,
                avgCycleDuration: 0
            };
            this.save();
        }
        return this.state.coins[coin];
    }

    public startCycle(coin: string, marketId: string, slug: string) {
        this.sync();
        this.state.activeCycles[marketId] = {
            id: slug,
            coin,
            startTs: Date.now(),
            yesCost: 0,
            noCost: 0,
            status: 'OPEN'
        };
        // Reset exposure for this specific cycle logic is handled in "updateCycleCost"
        this.save();
    }

    public updateCycleCost(marketId: string, yesCost: number, noCost: number) {
        this.sync();
        const cycle = this.state.activeCycles[marketId];
        if (cycle) {
            cycle.yesCost = yesCost;
            cycle.noCost = noCost;

            // Update Coin Exposure
            // Re-calc total exposure for coin
            const coin = cycle.coin;
            let totalExp = 0;
            Object.values(this.state.activeCycles).forEach(c => {
                if (c.coin === coin && c.status === 'OPEN') {
                    totalExp += (c.yesCost + c.noCost);
                }
            });

            const coinStats = this.getCoinStats(coin);
            coinStats.currentExposure = totalExp;
        }
        this.save();
    }

    public closeCycle(marketId: string, result: PnlReason, pnl: number) {
        this.sync();
        const cycle = this.state.activeCycles[marketId];
        if (cycle) {
            cycle.status = result;
            const coin = cycle.coin;
            const stats = this.getCoinStats(coin);

            stats.cyclesCompleted++;
            if (result === 'WIN' || result === 'EARLY_EXIT' || result === 'LATE_EXIT' || result === 'ARB') {
                stats.cyclesWon++;
            } else if (result === 'LOSS') {
                stats.cyclesLost++;
            } else {
                stats.cyclesAbandoned++;
            }

            stats.realizedPnL += pnl;

            // Recalc Exposure (remove this cycle)
            delete this.state.activeCycles[marketId];

            // Duration
            const duration = (Date.now() - cycle.startTs) / 1000;
            // Running avg approx
            const n = stats.cyclesCompleted;
            stats.avgCycleDuration = ((stats.avgCycleDuration * (n - 1)) + duration) / n;

            stats.currentExposure = 0; // Simplified re-calc next update or assume 0 if only 1 market
            // Re-calc total exposure properly
            let totalExp = 0;
            Object.values(this.state.activeCycles).forEach(c => {
                if (c.coin === coin && c.status === 'OPEN') {
                    totalExp += (c.yesCost + c.noCost);
                }
            });
            stats.currentExposure = totalExp;
        }
        this.save();
    }

    public getAllStats(): GlobalState {
        this.sync();
        return this.state;
    }
}
