import { Request, Response, NextFunction } from "express";
import BaseController from "../base-controller";
import adminAccessService from "../../../services/admin-access.service";

/**
 * Accepting an invitation to the admin team, for whoever is signed in
 * (mounted at /protected/admin-invites). The account must use the invited email.
 */
class AdminInviteController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.post("/:token/accept", this.accept.bind(this));
    }

    private async accept(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await adminAccessService.acceptInvite(String(req.params.token), res.locals.user.id);
            this.sendSuccess(res, { ...result, message: "You've joined the admin team. Sign in again to open the admin dashboard." });
        } catch (error) {
            next(error);
        }
    }
}

export default new AdminInviteController().router;
