import RoleMiddleware from "../../../middlewares/role.middleware";
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
            // Optional YYYY-MM-DD startDate / endDate (Lagos days) narrow every figure to that window
            const range = lagosDayRange(req.query.startDate, req.query.endDate);
            return this.sendSuccess(res, await dashboardService.getAdminDashboard(range));
        } catch (error: any) {
            return next(error);
        }
    }
}

export default new DashboardController().router;