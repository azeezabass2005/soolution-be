import crypto from "crypto";
import walletTransactionRepository from "../repositories/wallet-transaction.repository";

/** Start of the server's local day (the daily withdrawal limit window) */
const startOfLocalDay = () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start;
};

class WalletTransactionService {
    /** A unique wallet transaction reference, e.g. FND-LZ3K4-9F2A... */
    generateReference(prefix: string = "WTX"): string {
        const timestamp = Date.now().toString(36);
        const random = crypto.randomBytes(6).toString("hex");
        return `${prefix}-${timestamp}-${random}`.toUpperCase();
    }

    /** Total withdrawals for a user today that are successful or still in progress (daily limit) */
    async getDailyWithdrawalTotal(userId: string): Promise<number> {
        return walletTransactionRepository.withdrawalTotalSince(userId, startOfLocalDay());
    }
}

export default WalletTransactionService;
