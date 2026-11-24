import { Request, Response, NextFunction } from "express";
import BaseController from "../../base-controller";
import RoleMiddleware, { accessOf } from "../../../../middlewares/role.middleware";
import supportService, { type TicketKind } from "../../../../services/support.service";

/**
 * The team's side of support (mounted at /protected/admin/support). Support
 * conversations need "support"; disputes need "transactions.disputes".
 *   GET   /?kind=support|dispute&status=waiting|closed|all|<status>
 *   GET   /:id
 *   POST  /:id/messages   { body }
 *   PATCH /:id            { status, resolution? }
 */
class AdminSupportController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.use(RoleMiddleware.can("support", "transactions.disputes"));
        this.router.get("/", this.handle(async (req, kinds) => supportService.listForTeam(kinds, {
            kind: req.query.kind === "support" || req.query.kind === "dispute" ? req.query.kind : undefined,
            status: typeof req.query.status === "string" ? req.query.status : undefined,
        })));
        this.router.get("/:id", this.handle((req, kinds) => supportService.getForTeam(kinds, req.params.id)));
        this.router.post("/:id/messages", this.handle((req, kinds, res) => supportService.replyAsTeam(kinds, res.locals.user.id, req.params.id, req.body?.body)));
        this.router.patch("/:id", this.handle((req, kinds, res) => supportService.setStatus(kinds, res.locals.user.id, req.params.id, req.body)));
    }

    private handle(fn: (req: Request, kinds: TicketKind[], res: Response) => Promise<unknown>) {
        return async (req: Request, res: Response, next: NextFunction) => {
            try {
                const kinds = supportService.kindsFor(await accessOf(res));
                this.sendSuccess(res, await fn(req, kinds, res));
            } catch (error) {
                next(error);
            }
        };
    }
}

export default new AdminSupportController().router;
