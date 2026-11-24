import RoleMiddleware, { allowed } from "../../../middlewares/role.middleware";
import BaseController from "../base-controller";
import { Request, Response, NextFunction } from "express";
import dashboardService from "../../../services/dashboard.service";
import { lagosDayRange } from "../../../utils/date-range.utils";

class DashboardController extends BaseController {
    constructor () {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        // Routes to get the dashboard data
        this.router.get("/", RoleMiddleware.can("dashboard"), this.getDashboardData.bind(this));
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
            // Optional YYYY-MM-DD startDate / endDate (Lagos days) narrow every figure to that window
            const range = lagosDayRange(req.query.startDate, req.query.endDate);
            const data: Record<string, unknown> = await dashboardService.getAdminDashboard(range);
            // Money amounts are the "transaction volume" cards; without them only counts are sent
            if (!(await allowed(res, "dashboard.volume"))) {
                delete data.flows;
                delete data.amountTransactedNgn;
                delete data.totalAmountCompleted;
                data.manual = { count: (data.manual as { count: number }).count };
            }
            // The recent list is transaction history
            if (!(await allowed(res, "transactions"))) data.recentTransactions = [];
            return this.sendSuccess(res, data);
        } catch (error: any) {
            return next(error);
        }
    }
}

export default new DashboardController().router;