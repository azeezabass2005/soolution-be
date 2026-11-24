import transactionRepository from "../repositories/transaction.repository";
import userRepository from "../repositories/user.repository";
import { TRANSACTION_STATUS } from "../common/constant";
import type { TransactionStatus } from "../types/enums";
import type { DateRange } from "../utils/date-range.utils";

/** Admin dashboard metrics */
class DashboardService {
    /**
     * - totalUsers: count of users
     * - totalTransactions / totalAmountInitiated: every transaction, valued in its NGN/GHS equivalent
     * - totalTransactionsCompleted / totalAmountCompleted: completed or successful ones
     * - totalKYCVerified: users whose identity is verified (Tier 1 or above)
     * - pendingPayments: transactions awaiting admin confirmation
     * - recentTransactions: last 10 with basic owner info
     */
    /**
     * With a range, everything is for that window: users who signed up in it
     * (and of those, how many are verified) and transactions created in it.
     */
    async getAdminDashboard(range: DateRange = {}) {
        const created = { createdFrom: range.from, createdTo: range.to };
        const [totalUsers, totals, completed, totalKYCVerified, pendingPayments, recentTransactions] = await Promise.all([
            userRepository.count(created),
            transactionRepository.dashboardTotals(undefined, range),
            transactionRepository.dashboardTotals([TRANSACTION_STATUS.COMPLETED, TRANSACTION_STATUS.SUCCESSFUL] as TransactionStatus[], range),
            // Verified identity (Tier 1+): a BVN check verifies without an application, so isKYCDone misses them
            userRepository.count({ verified: true, ...created }),
            transactionRepository.count({ status: TRANSACTION_STATUS.AWAITING_CONFIRMATION as TransactionStatus, ...created }),
            transactionRepository.recentWithOwner(10, range),
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
