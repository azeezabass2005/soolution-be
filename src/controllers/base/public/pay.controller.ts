import rateLimit from "express-rate-limit";
import { NextFunction, Request, Response } from "express";
import BaseController from "../base-controller";
import paymentLinkService from "../../../services/payment-link.service";
import bankDirectoryService from "../../../services/bank-directory.service";

/**
 * The payer's side of a payment link. No account needed: they open the link,
 * fill in how they'll pay, and approve the payment on their phone or bank.
 */
class PayController extends BaseController {
    constructor() {
        super();
    }

    protected setupRoutes(): void {
        const viewLimiter = rateLimit({
            windowMs: 60 * 1000,
            max: 60,
            standardHeaders: true,
            legacyHeaders: false,
            message: { message: "Too many requests. Please try again shortly." },
        });
        // Each payment sends the payer a prompt, so keep strangers from spamming numbers
        const payLimiter = rateLimit({
            windowMs: 10 * 60 * 1000,
            max: 5,
            standardHeaders: true,
            legacyHeaders: false,
            message: { message: "Too many payment attempts. Please wait a few minutes and try again." },
        });

        this.router.get("/:slug", viewLimiter, this.view.bind(this));
        this.router.post("/:slug", payLimiter, this.pay.bind(this));
        this.router.get("/:slug/payments/:reference", viewLimiter, this.status.bind(this));
        this.router.get("/:slug/banks", viewLimiter, this.banks.bind(this));
    }

    /** Banks the payer can pay from, for the link's currency */
    private async banks(req: Request, res: Response, next: NextFunction) {
        try {
            const link = await paymentLinkService.getPublic(req.params.slug);
            const { banks, provider } = await bankDirectoryService.list(link.currency);
            this.sendSuccess(res, { banks, provider });
        } catch (error) {
            next(error);
        }
    }

    private async view(req: Request, res: Response, next: NextFunction) {
        try {
            const link = await paymentLinkService.getPublic(req.params.slug);
            this.sendSuccess(res, { link });
        } catch (error) {
            next(error);
        }
    }

    private async pay(req: Request, res: Response, next: NextFunction) {
        try {
            const payment = await paymentLinkService.pay(req.params.slug, req.body);
            this.sendSuccess(res, { payment, message: "Payment started" }, 201);
        } catch (error) {
            next(error);
        }
    }

    private async status(req: Request, res: Response, next: NextFunction) {
        try {
            const payment = await paymentLinkService.paymentStatus(req.params.slug, req.params.reference);
            this.sendSuccess(res, { payment });
        } catch (error) {
            next(error);
        }
    }
}

export default new PayController().router;
