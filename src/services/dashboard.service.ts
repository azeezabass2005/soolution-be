import transactionRepository from "../repositories/transaction.repository";
import userRepository from "../repositories/user.repository";
import { TRANSACTION_STATUS } from "../common/constant";
import type { TransactionStatus } from "../types/enums";

/** Admin dashboard metrics */
class DashboardService {
    /**
     * - totalUsers: count of users
     * - totalTransactions / totalAmountInitiated: every transaction, valued in its NGN/GHS equivalent
     * - totalTransactionsCompleted / totalAmountCompleted: completed or successful ones
     * - totalKYCVerified: users with an approved KYC
     * - pendingPayments: transactions awaiting admin confirmation
     * - recentTransactions: last 10 with basic owner info
     */
    async getAdminDashboard() {
        const [totalUsers, totals, completed, totalKYCVerified, pendingPayments, recentTransactions] = await Promise.all([
            userRepository.count(),
            transactionRepository.dashboardTotals(),
            transactionRepository.dashboardTotals([TRANSACTION_STATUS.COMPLETED, TRANSACTION_STATUS.SUCCESSFUL] as TransactionStatus[]),
            userRepository.count({ isKYCDone: true }),
            transactionRepository.count({ status: TRANSACTION_STATUS.AWAITING_CONFIRMATION as TransactionStatus }),
            transactionRepository.recentWithOwner(10),
        ]);

        return {
            totalUsers,
            totalTransactions: totals.count,
            totalAmountInitiated: totals.total,
            totalAmountCompleted: completed.total,
            totalTransactionsCompleted: completed.count,
            totalKYCVerified,
            pendingPayments,
            recentTransactions,
        };
    }
}

export default new DashboardService();
