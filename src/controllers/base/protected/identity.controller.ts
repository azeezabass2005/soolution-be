import { Request, Response, NextFunction } from "express";
import BaseController from "../base-controller";
import identityService from "../../../services/identity.service";
import errorResponseMessage, { ErrorSeverity } from "../../../common/messages/error-response-message";
import { ROLE_MAP } from "../../../common/constant";

/**
 * BVN verification (Smile ID) that unlocks Tier 1.
 *   GET  /            the signed-in user's verification state
 *   POST /bvn         submit a BVN with selfie images
 *   GET  /users/:id   admin: a user's state and recent checks
 *   POST /users/:id/reset-attempts   admin: let a user try again
 */
class IdentityController extends BaseController {

    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.get("/", this.getStatus.bind(this));
        this.router.post("/bvn", this.submitBvn.bind(this));
        this.router.get("/users/:userId", this.requireAdmin, this.getUserIdentity.bind(this));
        this.router.post("/users/:userId/reset-attempts", this.requireAdmin, this.resetAttempts.bind(this));
    }

    private requireAdmin(_req: Request, res: Response, next: NextFunction): void {
        if (res.locals.user?.role !== ROLE_MAP.ADMIN) {
            return next(errorResponseMessage.createError(403, "You don't have permission to perform this action", ErrorSeverity.HIGH));
        }
        next();
    }

    private async getStatus(_req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            this.sendSuccess(res, await identityService.getStatus(String(res.locals.user._id)));
        } catch (error) {
            next(error);
        }
    }

    private async submitBvn(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const status = await identityService.submitBvn(res.locals.user, req.body?.bvn, req.body?.images);
            this.sendSuccess(res, { message: "We're checking your BVN. This usually takes a minute or two.", ...status }, 201);
        } catch (error) {
            next(error);
        }
    }

    private async getUserIdentity(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = await this.userService.findById(req.params.userId);
            if (!user) return next(errorResponseMessage.resourceNotFound("User"));
            this.sendSuccess(res, await identityService.adminSummary(String(user._id)));
        } catch (error) {
            next(error);
        }
    }

    private async resetAttempts(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
            if (reason.length < 3) return next(errorResponseMessage.createError(400, "Please give a reason", ErrorSeverity.LOW));
            const user = await this.userService.findById(req.params.userId);
            if (!user) return next(errorResponseMessage.resourceNotFound("User"));
            this.sendSuccess(res, { message: "Attempts reset", ...(await identityService.adminResetAttempts(res.locals.user, String(user._id), reason.slice(0, 500))) });
        } catch (error) {
            next(error);
        }
    }
}

export default new IdentityController().router;
