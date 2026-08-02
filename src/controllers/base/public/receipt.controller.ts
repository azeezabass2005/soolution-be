import rateLimit from "express-rate-limit";
import BaseController from "../base-controller";
import receiptService from "../../../services/receipt.service";
import { Request, Response, NextFunction } from "express";

/**
 * Public receipt verification.
 *
 * A recipient who was sent a receipt image can scan its QR (or open the
 * short link) and confirm the transfer is genuine without holding an
 * account. Everything served here is a masked, allow-listed projection —
 * see receipt.service.ts.
 */
class ReceiptController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        // Public and unauthenticated, so it needs its own brake. Tokens are
        // 22 chars of base62 (~131 bits) — this is belt-and-braces against
        // someone pointing a script at it rather than a real defence.
        const verifyLimiter = rateLimit({
            windowMs: 60 * 1000,
            max: 30,
            standardHeaders: true,
            legacyHeaders: false,
            message: { message: "Too many verification attempts. Please try again shortly." },
        });

        this.router.get("/:token", verifyLimiter, this.verify.bind(this));
    }

    private async verify(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await receiptService.verify(req.params.token);
            // Always 200. A 404 here would confirm which tokens exist.
            this.sendSuccess(res, result);
        } catch (error) {
            next(error);
        }
    }
}

export default new ReceiptController().router;
