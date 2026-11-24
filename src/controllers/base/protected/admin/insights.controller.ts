import { NextFunction, Request, Response } from "express";
import treasuryService from "../../../../services/treasury.service";
import dashboardService from "../../../../services/dashboard.service";
import BaseController from "../../base-controller";
import RoleMiddleware from "../../../../middlewares/role.middleware";
import adminProfitService, { PROFIT_KINDS, type ProfitKind } from "../../../../services/admin-profit.service";
import adminBalancesService from "../../../../services/admin-balances.service";
import errorResponseMessage, { ErrorSeverity } from "../../../../common/messages/error-response-message";
import { isUuid } from "../../../../utils/id.utils";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A Lagos calendar day's start or end (WAT, UTC+1) */
const lagosDay = (ymd: string, end: boolean) => new Date(`${ymd}T${end ? "23:59:59.999" : "00:00:00.000"}+01:00`);

/**
 * Admin money insights (mounted at /protected/admin/insights):
 *   GET /profit     profit per transaction and per end-to-end flow
 *   GET /balances   provider balances against our books
 */
class AdminInsightsController extends BaseController {
    constructor() {
        super();
    }

    protected setupRoutes(): void {
        this.router.use(RoleMiddleware.isAdmin);
        this.router.get("/profit", this.profit.bind(this));
        this.router.get("/balances", this.balances.bind(this));
        // Whether provider balances cover what's going out
        this.router.get("/liquidity", this.wrap(async () => ({ lines: await treasuryService.liquidity() })));
        // The cost of moving money (taken off gross profit to give net)
        this.router.get("/expenses", this.wrap(async (req) => ({ expenses: await treasuryService.expenses(this.day(req.query.from), this.day(req.query.to)) })));
        this.router.post("/expenses", this.wrap(async (req, res) => treasuryService.addExpense(req.body, res.locals.user.id)));
        this.router.delete("/expenses/:id", this.wrap(async (req, res) => treasuryService.removeExpense(req.params.id, res.locals.user.id)));
    }

    private async profit(req: Request, res: Response, next: NextFunction) {
        try {
            const { from, to, userId, kinds } = req.query as Record<string, string | undefined>;
            if ((from && !DAY.test(from)) || (to && !DAY.test(to))) {
                return next(errorResponseMessage.createError(400, "Dates must look like 2026-11-19", ErrorSeverity.LOW));
            }
            const wanted = String(kinds || "").split(",").map((k) => k.trim()).filter((k): k is ProfitKind => (PROFIT_KINDS as string[]).includes(k));
            const rows = await adminProfitService.rows({
                from: from ? lagosDay(from, false) : undefined,
                to: to ? lagosDay(to, true) : undefined,
                userId: userId && isUuid(userId) ? userId : undefined,
                kinds: wanted,
            });
            // Naira through user wallets in the same window: funded, received, sent, paid out
            const walletFlows = await dashboardService.walletFlows({ from: from ? lagosDay(from, false) : undefined, to: to ? lagosDay(to, true) : undefined });
            // Revenue, gross and net profit for the same days (net takes off recorded expenses)
            const expenses = await treasuryService.expenses(from, to);
            const summary = treasuryService.summarize(rows, expenses.reduce((sum, e) => sum + (Number(e.amountNgn) || 0), 0));
            return this.sendSuccess(res, {
                summary,
                walletFlows,
                totals: adminProfitService.totals(rows),
                flows: adminProfitService.flows(rows),
                rows: rows.slice(0, 1000),
                truncated: rows.length > 1000,
            });
        } catch (error) {
            return next(error);
        }
    }

    private day(value: unknown): string | undefined {
        return typeof value === "string" && DAY.test(value) ? value : undefined;
    }

    private wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
        return async (req: Request, res: Response, next: NextFunction) => {
            try {
                this.sendSuccess(res, await fn(req, res));
            } catch (error) {
                next(error);
            }
        };
    }

    private async balances(_req: Request, res: Response, next: NextFunction) {
        try {
            const [report, reasons] = await Promise.all([adminBalancesService.report(), treasuryService.booksDifferenceReasons()]);
            return this.sendSuccess(res, { ...report, differenceReasons: reasons });
        } catch (error) {
            return next(error);
        }
    }
}

export default new AdminInsightsController().router;
