import BaseController from "../base-controller";
import TransactionService from "../../../services/transaction.service";
import ghsRateService from "../../../services/ghs-rate.service";
import fincraService, { GHS_MOMO_NETWORKS } from "../../../services/fincra.service";
import config from "../../../config/env.config";
import { Request, Response, NextFunction } from "express";
import { isUuid } from "../../../utils/id.utils";
import {
    validateCreateOGatewayPayout,
    validateCreateOGatewayCollection,
} from "../../../validators/z-ogateway-transaction";
import TransactionRateLimitMiddleware from "../../../middlewares/transaction-rate-limit.middleware";
import { DETAIL_TYPE, TRANSACTION_STATUS } from "../../../common/constant";
import errorResponseMessage, { ErrorSeverity } from "../../../common/messages/error-response-message";

import transactionLimitService from "../../../services/transaction-limit.service";
/**
 * GHS routes: send to Ghana mobile money or banks, and receive GHS through a
 * payment link, both through Fincra. Mounted at /protected/ogateway (the path
 * the app already calls) and /protected/ghs.
 */
class OGatewayTransactionController extends BaseController {
    private transactionService: TransactionService;

    constructor() {
        super();
        this.transactionService = new TransactionService();
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

        // Poll and sync a GHS payout/collection from OGateway. Used by the UI
        // while webhooks remain the primary source of truth.
        this.router.post("/poll-status/:transactionId", this.pollStatus.bind(this));

        // Static helpers used by the frontend.
        this.router.get("/networks", this.getNetworks.bind(this));
        this.router.get("/banks", this.getBanks.bind(this));
        this.router.get("/rates", this.getRates.bind(this));
        // The full price of sending or receiving `amount` GHS (rate, both fees, total)
        this.router.get("/price", this.getPrice.bind(this));
    }

    private async createPayout(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const idempotencyKey =
                req.body.idempotencyKey || (req.headers["idempotency-key"] as string);
            const transaction = await transactionLimitService.withUserLock(user.id, () => this.transactionService.createGhsPayoutTransaction(
                { ...req.body, idempotencyKey },
                user.id,
            ));
            return this.sendSuccess(
                res,
                {
                    transaction,
                    message: "Payment initiated successfully.",
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
            const transaction = await transactionLimitService.withUserLock(user.id, () => this.transactionService.createGhsCollectionTransaction(
                { ...req.body, idempotencyKey, redirectUrl: `${config.FRONTEND_URL}/dashboard/user/payments` },
                user.id,
            ));
            return this.sendSuccess(
                res,
                {
                    transaction,
                    message: "Payment link ready. Share it with the payer to pay by mobile money.",
                },
                201,
            );
        } catch (error) {
            return next(error);
        }
    }

    private async pollStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const { transactionId } = req.params;

            if (!isUuid(transactionId)) {
                return next(errorResponseMessage.createError(
                    400,
                    "Invalid transaction id",
                    ErrorSeverity.MEDIUM,
                ));
            }

            const transaction = await this.transactionService.findView(transactionId);
            if (!transaction) {
                return next(errorResponseMessage.resourceNotFound("Transaction"));
            }

            const ownerId = typeof transaction.user === "string" ? transaction.user : transaction.user.id;
            if (ownerId !== String(user.id)) {
                return next(errorResponseMessage.createError(
                    403,
                    "You are not allowed to poll this transaction",
                    ErrorSeverity.HIGH,
                ));
            }

            if (transaction.detailType !== DETAIL_TYPE.FINCRA) {
                return next(errorResponseMessage.createError(
                    400,
                    "This transaction's status can't be checked here.",
                    ErrorSeverity.MEDIUM,
                ));
            }

            const finalStatuses = [TRANSACTION_STATUS.COMPLETED, TRANSACTION_STATUS.FAILED];
            if (finalStatuses.includes(transaction.status as any)) {
                const detail = transaction.details;
                return this.sendSuccess(res, {
                    transaction: { ...transaction, details: detail ?? {} },
                    providerStatus: detail?.providerStatus || transaction.status,
                    message: "Transaction is already final.",
                });
            }

            const result = await this.transactionService.pollGhsStatus(transactionId);
            return this.sendSuccess(res, result);
        } catch (error) {
            return next(error);
        }
    }

    private async getNetworks(_req: Request, res: Response, next: NextFunction) {
        try {
            return this.sendSuccess(res, {
                country: "GH",
                networks: GHS_MOMO_NETWORKS.map(({ code, name }) => ({ code, name })),
            });
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Live GHS rate quote (Fincra plus the platform markup and fee). Restricted to the GHS pair we actually use
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
                    message: "Rates here are only available for GHS and NGN.",
                });
            }
            if (!isFinite(amount) || amount <= 0) {
                return next({ response_code: 400, message: "amount must be a positive number" });
            }

            const quote = await ghsRateService.quoteRate(source, destination, amount);
            return this.sendSuccess(res, quote);
        } catch (error) {
            return next(error);
        }
    }

    private async getPrice(req: Request, res: Response, next: NextFunction) {
        try {
            const direction = String(req.query.direction || "");
            const amount = Number(req.query.amount);
            if (direction !== "send" && direction !== "receive") return next({ response_code: 400, message: "direction must be send or receive" });
            if (!isFinite(amount) || amount <= 0) return next({ response_code: 400, message: "amount must be a positive number" });
            return this.sendSuccess(res, await ghsRateService.price(direction, amount));
        } catch (error) {
            return next(error);
        }
    }

    /** Ghana banks Fincra pays out to; `code` is what a bank send submits */
    private async getBanks(_req: Request, res: Response, next: NextFunction) {
        try {
            const banks = await fincraService.listBanks("GH", "GHS", "bank_account");
            return this.sendSuccess(res, {
                country: "GH",
                banks: banks.map((b) => ({ code: b.code, name: b.name })),
            });
        } catch (error) {
            return next(error);
        }
    }
}

export default new OGatewayTransactionController().router;
