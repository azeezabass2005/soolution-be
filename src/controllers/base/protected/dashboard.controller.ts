import RoleMiddleware, { allowed } from "../../../middlewares/role.middleware";
import treasuryService from "../../../services/treasury.service";
import adminProfitService from "../../../services/admin-profit.service";
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
        // Naira per USD, for showing dashboard and balance figures in USD
        this.router.get("/usd-rate", RoleMiddleware.can("dashboard", "profit_balances"), async (_req, res, next) => {
            try {
                return this.sendSuccess(res, await treasuryService.ngnPerUsd());
            } catch (error) {
                return next(error);
            }
        });
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
            // Super admins (profit & balances): revenue, gross and net profit for the same days
            if (await allowed(res, "profit_balances")) {
                const rows = await adminProfitService.rows({ from: range?.from, to: range?.to });
                const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
                const expenses = await treasuryService.expenses(day(req.query.startDate), day(req.query.endDate));
                data.treasury = treasuryService.summarize(rows, expenses.reduce((sum, e) => sum + (Number(e.amountNgn) || 0), 0));
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