/**
 * WalletGuard
 * Singleton class to track "In-Flight" reserved funds across strategy instances.
 * Prevents multiple strategies (if running in same process) from over-committing the wallet.
 */
export class WalletGuard {
    private static reserved = 0;

    /**
     * Attempts to reserve an amount of USD.
     * @param amount - Amount to reserve
     * @param balance - Current wallet balance from RPC
     * @returns true if reservation successful (balance - reserved >= amount), else false
     */
    static tryReserve(amount: number, balance: number): boolean {
        if (this.reserved + amount > balance) {
            return false;
        }
        this.reserved += amount;
        return true;
    }

    /**
     * Releases a previously reserved amount.
     * @param amount - Amount to release
     */
    static release(amount: number) {
        this.reserved -= amount;
        if (this.reserved < 0) this.reserved = 0; // Safety clamp
    }

    /**
     * Debug helper to see current reservation
     */
    static getReserved(): number {
        return this.reserved;
    }

    /**
     * Resets reservation to 0. 
     * CAUTION: Only call this when you have confirmed a fresh balance update 
     * that accounts for all previous in-flight orders.
     */
    static reset() {
        this.reserved = 0;
    }
}
