import BaseController from "../base-controller";
import TransactionService from "../../../services/transaction.service";
import yellowCardService from "../../../services/yellowcard.service";
import { Request, Response, NextFunction } from "express";
import { validateCreateYellowCardTransaction } from "../../../validators/z-yellowcard-transaction";
import TransactionRateLimitMiddleware from "../../../middlewares/transaction-rate-limit.middleware";

class YellowCardTransactionController extends BaseController {

    private transactionService: TransactionService;

    constructor() {
        super();
        this.transactionService = new TransactionService(["details", "user"]);
        this.setupRoutes();
    }

    protected setupRoutes() {
        // Create a new YellowCard automatic payment
        this.router.post(
            "/",
            TransactionRateLimitMiddleware.checkTransactionRateLimit,
            validateCreateYellowCardTransaction,
            this.createTransaction.bind(this)
        );

        // Get YellowCard channels for a country
        this.router.get("/channels", this.getChannels.bind(this));

        // Get YellowCard networks for a country
        this.router.get("/networks", this.getNetworks.bind(this));

        // Get YellowCard exchange rates
        this.router.get("/rates", this.getRates.bind(this));

        // Resolve a bank account before sending payment
        this.router.post("/resolve-bank", this.resolveBankAccount.bind(this));

        // Resolve a mobile money account before sending payment
        this.router.post("/resolve-momo", this.resolveMobileMoneyAccount.bind(this));

        // Lookup a YellowCard transaction status by our reference
        this.router.get("/status/:sequenceId", this.lookupTransactionStatus.bind(this));

        // Poll and sync payment status from YellowCard (used when webhooks aren't available)
        this.router.post("/poll-status/:transactionId", this.pollAndSyncStatus.bind(this));

        // Create a YellowCard collection (receive money)
        this.router.post(
            "/collect",
            TransactionRateLimitMiddleware.checkTransactionRateLimit,
            this.createCollectionTransaction.bind(this)
        );

        // Poll and sync collection status
        this.router.post("/poll-collection-status/:transactionId", this.pollCollectionStatus.bind(this));
    }

    private async createTransaction(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;

            const idempotencyKey = req.body.idempotencyKey || req.headers["idempotency-key"] as string;

            const transaction = await this.transactionService.createYellowCardTransaction(
                { ...req.body, idempotencyKey },
                user._id!,
                req.ip,
                req.headers["user-agent"]
            );

            return this.sendSuccess(res, {
                transaction,
                message: "YellowCard automatic payment initiated successfully.",
            }, 201);
        } catch (error: any) {
            return next(error);
        }
    }

    private async getChannels(req: Request, res: Response, next: NextFunction) {
        try {
            const country = req.query.country as string | undefined;
            const channels = await yellowCardService.getChannels(country);
            return this.sendSuccess(res, channels);
        } catch (error: any) {
            return next(error);
        }
    }

    private async getNetworks(req: Request, res: Response, next: NextFunction) {
        try {
            const country = req.query.country as string | undefined;
            const networks = await yellowCardService.getNetworks(country);
            return this.sendSuccess(res, networks);
        } catch (error: any) {
            return next(error);
        }
    }

    private async getRates(req: Request, res: Response, next: NextFunction) {
        try {
            const rates = await yellowCardService.getRates();
            return this.sendSuccess(res, rates);
        } catch (error: any) {
            return next(error);
        }
    }

    private async resolveBankAccount(req: Request, res: Response, next: NextFunction) {
        try {
            const { accountNumber, networkId, country } = req.body;
            if (!accountNumber || !networkId || !country) {
                return next({
                    response_code: 400,
                    message: "accountNumber, networkId, and country are required",
                });
            }
            const result = await yellowCardService.resolveBankAccount(accountNumber, networkId, country);
            return this.sendSuccess(res, result);
        } catch (error: any) {
            return next(error);
        }
    }

    private async resolveMobileMoneyAccount(req: Request, res: Response, next: NextFunction) {
        try {
            const { accountNumber, networkId, country } = req.body;
            if (!accountNumber || !networkId || !country) {
                return next({
                    response_code: 400,
                    message: "accountNumber, networkId, and country are required",
                });
            }
            const result = await yellowCardService.resolveMobileMoneyAccount(accountNumber, networkId, country);
            return this.sendSuccess(res, result);
        } catch (error: any) {
            return next(error);
        }
    }

    private async lookupTransactionStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const { sequenceId } = req.params;
            const paymentResult = await yellowCardService.lookupPaymentBySequenceId(sequenceId);
            return this.sendSuccess(res, { payment: paymentResult });
        } catch (error: any) {
            return next(error);
        }
    }

    /**
     * Poll YellowCard for the current payment status and sync it to our local transaction.
     * This is used when webhooks aren't available (e.g. localhost development).
     */
    private async pollAndSyncStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const { transactionId } = req.params;
            const result = await this.transactionService.pollYellowCardStatus(transactionId);
            return this.sendSuccess(res, result);
        } catch (error: any) {
            return next(error);
        }
    }

    private async createCollectionTransaction(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const idempotencyKey = req.body.idempotencyKey || req.headers["idempotency-key"] as string;

            const transaction = await this.transactionService.createYellowCardCollectionTransaction(
                { ...req.body, idempotencyKey },
                user._id!,
            );

            return this.sendSuccess(res, {
                transaction,
                message: "Collection request initiated. The sender will receive payment instructions.",
            }, 201);
        } catch (error: any) {
            return next(error);
        }
    }

    private async pollCollectionStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const { transactionId } = req.params;
            const result = await this.transactionService.pollYellowCardCollectionStatus(transactionId);
            return this.sendSuccess(res, result);
        } catch (error: any) {
            return next(error);
        }
    }

}

export default new YellowCardTransactionController().router;
