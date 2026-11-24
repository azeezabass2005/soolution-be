import { Request, Response, NextFunction } from "express";
import BaseController from "../../base-controller";
import RoleMiddleware from "../../../../middlewares/role.middleware";
import approvalService from "../../../../services/approval.service";

/**
 * Large payouts held for an admin (mounted at /protected/admin/approvals;
 * the "transactions" permission):
 *   GET  /?status=pending|decided
 *   POST /:id/approve
 *   POST /:id/reject   { reason }
 */
class AdminApprovalsController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.use(RoleMiddleware.can("transactions"));
        this.router.get("/", this.handle((req) => approvalService.list(req.query.status === "decided" ? "decided" : "pending")));
        this.router.post("/:id/approve", this.handle((req, res) => approvalService.approve(req.params.id, res.locals.user.id)));
        this.router.post("/:id/reject", this.handle((req, res) => approvalService.reject(req.params.id, res.locals.user.id, req.body?.reason)));
    }

    private handle(fn: (req: Request, res: Response) => Promise<unknown>) {
        return async (req: Request, res: Response, next: NextFunction) => {
            try {
                this.sendSuccess(res, await fn(req, res));
            } catch (error) {
                next(error);
            }
        };
    }
}

export default new AdminApprovalsController().router;
