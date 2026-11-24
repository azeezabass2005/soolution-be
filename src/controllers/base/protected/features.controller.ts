import { NextFunction, Request, Response } from "express";
import BaseController from "../base-controller";
import RoleMiddleware from "../../../middlewares/role.middleware";
import featuresService from "../../../services/features.service";

/**
 * GET  /protected/features              which features the signed-in user gets
 * GET  /protected/features/admin        the registry with modes, and beta users (platform controls)
 * PUT  /protected/features/admin/users/:id  { beta } add or remove a beta user
 * Feature modes are saved through platform settings (operations.features).
 */
class FeaturesController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.get("/", this.handle((_req, res) => featuresService.forUser(res.locals.user)));
        this.router.get("/admin", RoleMiddleware.can("platform_controls"), this.handle(() => featuresService.overview()));
        this.router.put("/admin/users/:id", RoleMiddleware.can("platform_controls"), this.handle((req, res) => featuresService.setBeta(req.params.id, req.body?.beta === true, res.locals.user.id)));
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

export default new FeaturesController().router;
