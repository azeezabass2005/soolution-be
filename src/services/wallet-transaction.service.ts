import DBService from "../utils/db.utils";
import { IWalletTransaction } from "../models/interface";
import WalletTransaction from "../models/wallet-transaction.model";
import crypto from "crypto";
import { WALLET_TRANSACTION_TYPE, WALLET_TRANSACTION_STATUS } from "../common/constant";

class WalletTransactionService extends DBService<IWalletTransaction> {
    constructor(populatePaths: string[] = []) {
        super(WalletTransaction, populatePaths);
    }

    /**
     * Generate a unique wallet transaction reference
     */
    generateReference(prefix: string = 'WTX'): string {
        const timestamp = Date.now().toString(36);
        const random = crypto.randomBytes(6).toString('hex');
        return `${prefix}-${timestamp}-${random}`.toUpperCase();
    }

    /**
     * Get total successful withdrawals for a user today (for daily limit check)
     */
    async getDailyWithdrawalTotal(userId: string): Promise<number> {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const result = await this.Model.aggregate([
            {
                $match: {
                    user: userId,
                    type: WALLET_TRANSACTION_TYPE.WITHDRAWAL,
                    status: { $in: [WALLET_TRANSACTION_STATUS.SUCCESSFUL, WALLET_TRANSACTION_STATUS.PROCESSING, WALLET_TRANSACTION_STATUS.PENDING] },
                    createdAt: { $gte: startOfDay },
                }
            },
            {
                $group: {
                    _id: null,
                    total: { $sum: "$amount" }
                }
            }
        ]);

        return result.length > 0 ? result[0].total : 0;
    }
}

export default WalletTransactionService;
