import { NextFunction, Request, Response } from "express";
import BaseController from "../base-controller";
import platformSettingsService from "../../../services/platform-settings.service";
import { SUPPORT_CONTACT } from "../../../common/operations";

/**
 * Whether the platform is paused, so the app can say so up front
 * (GET /public/status). Nothing private: the switches and the note.
 */
class StatusController extends BaseController {
    constructor() {
        super();
    }

    protected setupRoutes(): void {
        this.router.get("/", this.status.bind(this));
    }

    private async status(_req: Request, res: Response, next: NextFunction) {
        try {
            const { pause } = await platformSettingsService.getOperations();
            return this.sendSuccess(res, {
                paymentsPaused: pause.payments,
                loginsPaused: pause.logins,
                message: pause.message || null,
                support: SUPPORT_CONTACT,
            });
        } catch (error) {
            return next(error);
        }
    }
}

export default new StatusController().router;
