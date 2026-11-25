import { Request, Response, NextFunction } from "express";
import BaseController from "../../base-controller";
import RoleMiddleware from "../../../../middlewares/role.middleware";
import receiveHoldsService from "../../../../services/receive-holds.service";

/** Large receives held for checks: list them, and allow one to be withdrawn */
class AdminReceiveHoldsController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.get("/", RoleMiddleware.can("transactions"), this.handle((req) => receiveHoldsService.list(req.query.status === "released" ? "released" : "held")));
        this.router.post("/:id/release", RoleMiddleware.can("transactions.release_holds"), this.handle((req, res) => receiveHoldsService.release(req.params.id, res.locals.user.id)));
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

export default new AdminReceiveHoldsController().router;
