import { NextFunction, Request, Response } from "express";
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
            return this.sendSuccess(res, {
                totals: adminProfitService.totals(rows),
                flows: adminProfitService.flows(rows),
                rows: rows.slice(0, 1000),
                truncated: rows.length > 1000,
            });
        } catch (error) {
            return next(error);
        }
    }

    private async balances(_req: Request, res: Response, next: NextFunction) {
        try {
            return this.sendSuccess(res, await adminBalancesService.report());
        } catch (error) {
            return next(error);
        }
    }
}

export default new AdminInsightsController().router;
