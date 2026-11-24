import { Request, Response, NextFunction } from "express";
import BaseController from "../base-controller";
import supportService, { type TicketKind } from "../../../services/support.service";

/**
 * A user's own support conversations and disputes (mounted at /protected/support):
 *   GET  /?kind=support|dispute
 *   POST /                    { kind?, subject, body, transactionId? (disputes) }
 *   GET  /:id
 *   POST /:id/messages        { body }
 */
class SupportController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.get("/", this.handle((req, res) => supportService.listMine(res.locals.user.id, this.kind(req.query.kind))));
        this.router.post("/", this.handle((req, res) => supportService.open(res.locals.user.id, req.body), 201));
        this.router.get("/:id", this.handle((req, res) => supportService.getMine(res.locals.user.id, req.params.id)));
        this.router.post("/:id/messages", this.handle((req, res) => supportService.replyAsUser(res.locals.user.id, req.params.id, req.body?.body)));
    }

    private kind(value: unknown): TicketKind | undefined {
        return value === "support" || value === "dispute" ? value : undefined;
    }

    private handle(fn: (req: Request, res: Response) => Promise<unknown>, status = 200) {
        return async (req: Request, res: Response, next: NextFunction) => {
            try {
                this.sendSuccess(res, await fn(req, res), status);
            } catch (error) {
                next(error);
            }
        };
    }
}

export default new SupportController().router;
