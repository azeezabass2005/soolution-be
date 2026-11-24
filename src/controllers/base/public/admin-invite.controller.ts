import { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import BaseController from "../base-controller";
import adminAccessService from "../../../services/admin-access.service";

const lookupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { message: "Too many requests. Please wait a few minutes." } });

/**
 * What an invitation link is for, before signing in (mounted at
 * /public/admin-invites): the role and a masked email, nothing else.
 */
class PublicAdminInviteController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.get("/:token", lookupLimiter, this.describe.bind(this));
    }

    private async describe(req: Request, res: Response, next: NextFunction) {
        try {
            this.sendSuccess(res, await adminAccessService.describeInvite(String(req.params.token)));
        } catch (error) {
            next(error);
        }
    }
}

export default new PublicAdminInviteController().router;
