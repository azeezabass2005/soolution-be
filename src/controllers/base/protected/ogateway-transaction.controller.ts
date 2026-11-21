import spotflowService from "../../../services/spotflow.service";
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
import platformSettingsService from "../../../services/platform-settings.service";
import { isManualSendCurrency, MANUAL_SEND_CURRENCIES, manualWindow } from "../../../common/operations";
import { MANUAL_GHS_SEND } from "../../../common/wallet.constants";
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

        // Whether manual GHS sends are open right now, their hours and the manual rate
        this.router.get("/manual", this.manualInfo.bind(this));

        // Send NGN → GHS manually (larger amounts, no fee, paid by ops)
        this.router.post(
            "/manual",
            TransactionRateLimitMiddleware.checkTransactionRateLimit,
            this.createManualPayout.bind(this),
        );

        // Top up the NGN wallet by paying GHS yourself (Fincra checkout); converts to naira on arrival
        this.router.post(
            "/top-up",
            TransactionRateLimitMiddleware.checkTransactionRateLimit,
            this.createTopUp.bind(this),
        );

        // Receive GHS → NGN (instant collection).
        this.router.post(
            "/collect",
            TransactionRateLimitMiddleware.checkTransactionRateLimit,
            validateCreateOGatewayCollection,
            this.createCollection.bind(this),
        );

        // Receive GHS by bank transfer into a one-time account (Spotflow)
        this.router.get("/account", this.accountAvailability.bind(this));
        this.router.post(
            "/account",
            TransactionRateLimitMiddleware.checkTransactionRateLimit,
            this.createAccount.bind(this),
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

    private async createTopUp(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const amount = Number(req.body?.amount);
            if (!(amount > 0)) return next(errorResponseMessage.payloadIncorrect("Enter how many cedis you're paying in"));
            const transaction = await transactionLimitService.withUserLock(user.id, () => this.transactionService.createGhsCollectionTransaction({
                amount,
                fromCurrency: "GHS",
                toCurrency: "NGN",
                idempotencyKey: typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined,
                payer: { name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(), email: user.email },
                redirectUrl: `${config.FRONTEND_URL}/dashboard/user/wallet?topup=done`,
                topUp: true,
            }, user.id));
            return this.sendSuccess(res, { transaction }, 201);
        } catch (error) {
            return next(error);
        }
    }

    /** Manual sends for one currency (?currency=GHS|KES|XAF|RMB, GHS by default): open now, hours, rate */
    private async manualInfo(req: Request, res: Response, next: NextFunction) {
        try {
            const currency = String(req.query.currency || "GHS").toUpperCase();
            if (!isManualSendCurrency(currency)) {
                return this.sendSuccess(res, { currency, rate: null, available: false, open: false, opensAt: null, hours: "", minNgn: 0, supported: false });
            }
            const ops = await platformSettingsService.getOperations();
            const window = manualWindow(ops.manual);
            const rate = ops.manual.rates[currency];
            return this.sendSuccess(res, {
                currency,
                supported: true,
                /** Naira per cedi for manual sends; null when the admin hasn't set one */
                rate: rate > 0 ? rate : null,
                available: window.open && rate > 0,
                open: window.open,
                opensAt: window.opensAt,
                hours: window.hours,
                /** Every manual currency's rate, so the app can price any manual send */
                rates: Object.fromEntries(MANUAL_SEND_CURRENCIES.map((c) => [c, ops.manual.rates[c] > 0 ? ops.manual.rates[c] : null])),
                // The ₦500,000 floor is for manual GHS only
                minNgn: currency === "GHS" ? MANUAL_GHS_SEND.MIN_NGN : 0,
            });
        } catch (error) {
            return next(error);
        }
    }

    private async createManualPayout(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const idempotencyKey = req.body?.idempotencyKey || (req.headers["idempotency-key"] as string);
            const transaction = await transactionLimitService.withUserLock(user.id, () => this.transactionService.createManualGhsSend(
                { ...req.body, idempotencyKey },
                user.id,
            ));
            return this.sendSuccess(res, { transaction, message: "We've got it. Your payment will be sent within 1–2 hours (8am–8pm WAT, business days)." }, 201);
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

    /** Whether one-time GHS accounts can be offered right now */
    private async accountAvailability(_req: Request, res: Response) {
        return this.sendSuccess(res, { available: spotflowService.ghsAccountsAvailable });
    }

    private async createAccount(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const idempotencyKey = req.body?.idempotencyKey || (req.headers["idempotency-key"] as string);
            const transaction = await transactionLimitService.withUserLock(user.id, () =>
                this.transactionService.createGhsAccountCollection({ amount: Number(req.body?.amount), idempotencyKey }, user.id),
            );
            return this.sendSuccess(res, { transaction, message: "Account ready. Ask the payer to transfer the exact amount." }, 201);
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
