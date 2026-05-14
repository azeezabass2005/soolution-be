import BaseController from "../base-controller";
import PinService from "../../../services/pin.service";
import { Request, Response, NextFunction } from "express";
import {
    validateSetTransactionPin,
    validateChangeTransactionPin,
    validateForgotTransactionPin,
} from "../../../validators";
import NotificationService from "../../../utils/notification.utils";
import config from "../../../config/env.config";

/**
 * Controller for transaction-PIN management. Mounts at /protected/pin.
 *  - POST /set     set the PIN for the first time
 *  - POST /change  change an existing PIN
 *  - POST /forgot  email a reset link (always returns generic success)
 *  - GET  /status  pre-flight: { isTransactionPinSet, isLocked, lockedUntil }
 */
class PinController extends BaseController {
    private pinService: PinService;
    private notificationService: NotificationService;

    constructor() {
        super();
        this.pinService = new PinService();
        this.notificationService = new NotificationService();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.post("/set", validateSetTransactionPin, this.setPin.bind(this));
        this.router.post("/change", validateChangeTransactionPin, this.changePin.bind(this));
        this.router.post("/forgot", validateForgotTransactionPin, this.forgotPin.bind(this));
        this.router.get("/status", this.getStatus.bind(this));
    }

    private async setPin(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            await this.pinService.setPin(user._id!, req.body.pin);
            return this.sendSuccess(res, { message: "Transaction PIN set successfully" });
        } catch (error) {
            return next(error);
        }
    }

    private async changePin(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            await this.pinService.changePin(user._id!, req.body.oldPin, req.body.newPin);
            return this.sendSuccess(res, { message: "Transaction PIN changed successfully" });
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Send the authenticated user a one-time PIN reset link via email.
     * Always responds 200 to avoid leaking which accounts exist.
     */
    private async forgotPin(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;

            // Always succeed at the API level — failures are logged but never surfaced.
            this.sendSuccess(res, {
                message: "If your account exists, a PIN reset link has been sent to your email.",
            });

            try {
                const token = await this.pinService.issueResetToken(user.email);
                if (token) {
                    const resetUrl = `${config.FRONTEND_URL}/auth/reset-pin?token=${encodeURIComponent(token)}`;
                    await this.notificationService.emailService.sendPinResetEmail(user.email, {
                        name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'there',
                        resetUrl,
                        expiryTime: '30 minutes',
                    });
                    this.logger.info("Transaction PIN reset email sent", { userId: user._id });
                }
            } catch (sendError) {
                this.logger.error("Failed to send PIN reset email", {
                    userId: user._id,
                    error: sendError instanceof Error ? sendError.message : String(sendError),
                });
            }
        } catch (error) {
            return next(error);
        }
    }

    private async getStatus(_req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const status = await this.pinService.getStatus(user._id!);
            return this.sendSuccess(res, status);
        } catch (error) {
            return next(error);
        }
    }
}

export default new PinController().router;
