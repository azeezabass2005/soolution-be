import RoleMiddleware from "../../../middlewares/role.middleware";
import BaseController from "../base-controller";
import { Request, Response, NextFunction } from "express";
import User from "../../../models/user.model";
import Transaction from "../../../models/transaction.model";
import { TRANSACTION_STATUS } from "../../../common/constant";

class DashboardController extends BaseController {
    constructor () {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        // Routes to get the dashboard data
        this.router.get("/", RoleMiddleware.isAdmin, this.getDashboardData.bind(this));
    }

    /**
     * Returns key dashboard metrics for admins
     * - totalUsers: count of users
     * - totalTransactions: count of transactions
     * - totalAmountInitiated: sum of `amount` across all transactions
     * - totalAmountCompleted: sum of `amount` where status is completed or successful
     * - recentTransactions: last 10 transactions (populated with basic user info)
     */
    private async getDashboardData(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // total users
            const totalUsers = await User.countDocuments({});

            // aggregate totals for transactions
            const totals = await Transaction.aggregate([
                {
                    $group: {
                        _id: null,
                        totalAmount: { $sum: "$amount" },
                        count: { $sum: 1 }
                    }
                }
            ]);

            const totalTransactions = totals?.[0]?.count || 0;
            const totalAmountInitiated = totals?.[0]?.totalAmount || 0;

            // sum of completed/successful transactions
            const completedTotals = await Transaction.aggregate([
                {
                    $match: { status: { $in: [TRANSACTION_STATUS.COMPLETED, TRANSACTION_STATUS.SUCCESSFUL] } }
                },
                {
                    $group: {
                        _id: null,
                        totalCompletedAmount: { $sum: "$amount" },
                        completedCount: { $sum: 1 }
                    }
                }
            ]);

            const totalAmountCompleted = completedTotals?.[0]?.totalCompletedAmount || 0;

            // count pending transactions (awaiting_confirmation only)
            const pendingCount = await Transaction.countDocuments({
                status: TRANSACTION_STATUS.AWAITING_CONFIRMATION
            });

            // recent transactions (latest 10) with basic user info
            const recentTransactions = await Transaction.find({})
                .sort({ createdAt: -1 })
                .limit(10)
                .populate('user', 'firstName lastName email')
                .lean();

            return this.sendSuccess(res, {
                totalUsers,
                totalTransactions,
                totalAmountInitiated,
                totalAmountCompleted,
                pendingPayments: pendingCount,
                recentTransactions,
            });
        } catch (error: any) {
            return next(error);
        }
    }
}

export default new DashboardController().router;