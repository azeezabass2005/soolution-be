import BaseController from "../base-controller";
import TransactionService from "../../../services/transaction.service";
import ogatewayService from "../../../services/ogateway.service";
import { Request, Response, NextFunction } from "express";
import {
    validateCreateOGatewayPayout,
    validateCreateOGatewayCollection,
} from "../../../validators/z-ogateway-transaction";
import TransactionRateLimitMiddleware from "../../../middlewares/transaction-rate-limit.middleware";
import { OGATEWAY_NETWORKS } from "../../../common/constant";

/**
 * OGateway routes — Ghana instant send + receive only.
 * YellowCard continues to handle every other currency.
 */
class OGatewayTransactionController extends BaseController {
    private transactionService: TransactionService;

    constructor() {
        super();
        this.transactionService = new TransactionService(["details", "user"]);
        this.setupRoutes();
    }

    protected setupRoutes() {
        // Send NGN → GHS (instant payout).
        this.router.post(
            "/",
            TransactionRateLimitMiddleware.checkTransactionRateLimit,
            validateCreateOGatewayPayout,
            this.createPayout.bind(this),
        );

        // Receive GHS → NGN (instant collection).
        this.router.post(
            "/collect",
            TransactionRateLimitMiddleware.checkTransactionRateLimit,
            validateCreateOGatewayCollection,
            this.createCollection.bind(this),
        );

        // Static helpers used by the frontend.
        this.router.get("/networks", this.getNetworks.bind(this));
        this.router.get("/banks", this.getBanks.bind(this));
        this.router.get("/rates", this.getRates.bind(this));
    }

    private async createPayout(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const idempotencyKey =
                req.body.idempotencyKey || (req.headers["idempotency-key"] as string);
            const transaction = await this.transactionService.createOGatewayPayoutTransaction(
                { ...req.body, idempotencyKey },
                user._id!,
            );
            return this.sendSuccess(
                res,
                {
                    transaction,
                    message: "OGateway payout initiated successfully.",
                },
                201,
            );
        } catch (error) {
            return next(error);
        }
    }

    private async createCollection(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const idempotencyKey =
                req.body.idempotencyKey || (req.headers["idempotency-key"] as string);
            const transaction = await this.transactionService.createOGatewayCollectionTransaction(
                { ...req.body, idempotencyKey },
                user._id!,
            );
            return this.sendSuccess(
                res,
                {
                    transaction,
                    message: "Collection request initiated. The sender will receive payment instructions.",
                },
                201,
            );
        } catch (error) {
            return next(error);
        }
    }

    private async getNetworks(_req: Request, res: Response, next: NextFunction) {
        try {
            return this.sendSuccess(res, {
                country: "GH",
                networks: OGATEWAY_NETWORKS.map((code) => ({ code, name: code })),
            });
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Live OGateway rate quote. Restricted to the GHS pair we actually use
     * — guards against the endpoint being abused as a generic FX proxy.
     */
    private async getRates(req: Request, res: Response, next: NextFunction) {
        try {
            const source = String(req.query.source || "GHS").toUpperCase();
            const destination = String(req.query.destination || "NGN").toUpperCase();
            const amountRaw = req.query.amount;
            const amount = amountRaw !== undefined ? parseFloat(String(amountRaw)) : 1;

            const allowed = new Set(["GHS", "NGN"]);
            if (!allowed.has(source) || !allowed.has(destination) || source === destination) {
                return next({
                    response_code: 400,
                    message: "OGateway rates are only quoted for the GHS↔NGN pair",
                });
            }
            if (!isFinite(amount) || amount <= 0) {
                return next({ response_code: 400, message: "amount must be a positive number" });
            }

            const quote = await ogatewayService.quoteRate(source, destination, amount);
            return this.sendSuccess(res, quote);
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Free-text bank fallback until the full Ghana bank list is pulled in
     * (see blocker #5 in backend/docs/ogateway-integration-blockers.md).
     * The frontend treats this as "submit raw code", so an empty list is fine.
     */
    private async getBanks(_req: Request, res: Response, next: NextFunction) {
        try {
            return this.sendSuccess(res, {
                country: "GH",
                banks: [] as Array<{ code: string; name: string }>,
                note: "Free-text bank code input until the full Ghana bank list is wired.",
            });
        } catch (error) {
            return next(error);
        }
    }
}

export default new OGatewayTransactionController().router;
