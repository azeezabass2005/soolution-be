import BaseController from "../base-controller";
import TransactionService from "../../../services/transaction.service";
import {Request, Response, NextFunction} from "express";
import {DetailType, ITransaction, ITransactionDetail} from "../../../models/interface";
import errorResponseMessage from "../../../common/messages/error-response-message";
import {validateCreateAlipayTransaction, validateCreateBankTransferTransaction} from "../../../validators/z-transaction";
import {ROLE_MAP, TRANSACTION_STATUS} from "../../../common/constant";
import RoleMiddleware from "../../../middlewares/role.middleware";
import TransactionMiddleware from "../../../middlewares/transaction.middleware";
import TransactionRateLimitMiddleware from "../../../middlewares/transaction-rate-limit.middleware";
import ReceiptFileValidationMiddleware from "../../../middlewares/receipt-file-validation.middleware";
import {MulterMiddleware} from "../../../middlewares/multer.middleware";
import receiptService from "../../../services/receipt.service";

class TransactionController extends BaseController {

    private transactionService: TransactionService;

    constructor() {
        super();
        this.transactionService = new TransactionService(['details', 'user']);
        this.setupRoutes()
    }

    protected setupRoutes() {
        // Mint (or fetch) the opaque token that backs this transaction's
        // public receipt verification page. Owner-only; see receipt.service.
        this.router.post("/:id/receipt-token", this.getReceiptToken.bind(this));

        // Route to create alipay transaction
        this.router.post("/alipay", MulterMiddleware.single('alipayQrCode'), MulterMiddleware.handleError, TransactionRateLimitMiddleware.checkTransactionRateLimit, validateCreateAlipayTransaction, this.createAlipayTransaction.bind(this));

        // Route to create bank transfer / mobile money transaction (GHS, XAF, KES)
        this.router.post("/bank-transfer", TransactionRateLimitMiddleware.checkTransactionRateLimit, validateCreateBankTransferTransaction, this.createBankTransferTransaction.bind(this));

        // Route for user to get alipay transactions
        this.router.get("/alipay", (req: Request, res: Response, next: NextFunction) => this.getAlipayTransactions(req, res, next, false));

        // Route for user to get bank transfer transactions
        this.router.get("/bank-transfer", (req: Request, res: Response, next: NextFunction) => this.getBankTransferTransactions(req, res, next, false));

        // Route for user to get alipay transactions
        this.router.get("/alipay-admin", RoleMiddleware.isAdmin, (req: Request, res: Response, next: NextFunction) => this.getAlipayTransactions(req, res, next, true));

        // Route for admin to get bank transfer transactions
        this.router.get("/bank-transfer-admin", RoleMiddleware.isAdmin, (req: Request, res: Response, next: NextFunction) => this.getBankTransferTransactions(req, res, next, true));

        // Route for user to upload payment receipt
        this.router.patch("/alipay/user-receipt/:id", MulterMiddleware.receipt('receipt'), MulterMiddleware.handleError, ReceiptFileValidationMiddleware.validateReceiptFile, TransactionMiddleware.verifyOwnership, this.uploadUserPaymentReceipt.bind(this));

        // Route for user to upload payment receipt for bank transfer
        this.router.patch("/bank-transfer/user-receipt/:id", MulterMiddleware.receipt('receipt'), MulterMiddleware.handleError, ReceiptFileValidationMiddleware.validateReceiptFile, TransactionMiddleware.verifyOwnership, this.uploadUserPaymentReceipt.bind(this));

        // Route for admin to upload payment receipt
        this.router.patch("/alipay/admin-receipt/:id", RoleMiddleware.isAdmin, MulterMiddleware.receipt('receipt'), MulterMiddleware.handleError, ReceiptFileValidationMiddleware.validateReceiptFile, this.uploadAdminPaymentReceipt.bind(this));

        // Route for admin to upload payment receipt for bank transfer
        this.router.patch("/bank-transfer/admin-receipt/:id", RoleMiddleware.isAdmin, MulterMiddleware.receipt('receipt'), MulterMiddleware.handleError, ReceiptFileValidationMiddleware.validateReceiptFile, this.uploadAdminPaymentReceipt.bind(this));
    }

    /**
     * Owner-only. Returns the stable receipt token so the client can embed
     * a verification link/QR in the generated receipt image.
     */
    private async getReceiptToken(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const token = await receiptService.getOrCreateToken(req.params.id, String(user._id));
            return this.sendSuccess(res, { token });
        } catch (error) {
            return next(error);
        }
    }

    private async createAlipayTransaction(req: Request, res: Response, next: NextFunction) {
        try {
            const transactionData: Partial<ITransaction & ITransactionDetail & { paymentMethod: DetailType; idempotencyKey?: string; pin?: string }> = req.body;

            // Extract idempotency key from header if not in body
            const idempotencyKey = transactionData.idempotencyKey || req.headers['idempotency-key'] as string;

            const user = res.locals.user;

            if(!req.file) {
                next(errorResponseMessage.payloadIncorrect("Alipay Qrcode"));
                return;
            }

            const transaction = await this.transactionService.createAlipayTransaction(
                { ...transactionData, idempotencyKey },
                req.file as Express.Multer.File,
                user._id!,
                req.ip,
                req.headers['user-agent']
            )

            return this.sendSuccess(res, {
                transaction,
                message: 'Transaction initiated successfully, please proceed to pay into the provided account number.'
            })
        } catch (error: any) {
            return next(error);
        }
    }

    private async createBankTransferTransaction(req: Request, res: Response, next: NextFunction) {
        try {
            const transactionData: Partial<ITransaction & ITransactionDetail & { paymentMethod: DetailType; toCurrency: string; institutionType: string; idempotencyKey?: string; transactionType?: 'send' | 'receive'; pin?: string }> = req.body;

            // Extract idempotency key from header if not in body
            const idempotencyKey = transactionData.idempotencyKey || req.headers['idempotency-key'] as string;

            const user = res.locals.user;

            const transaction = await this.transactionService.createBankTransferTransaction(
                { ...transactionData, idempotencyKey },
                user._id!,
                req.ip,
                req.headers['user-agent']
            )

            return this.sendSuccess(res, {
                transaction,
                message: 'Transaction initiated successfully, please proceed to pay into the provided account number.'
            })
        } catch (error: any) {
            return next(error);
        }
    }

    private async uploadUserPaymentReceipt(req: Request, res: Response, next: NextFunction) {
        try {
            if(!req.file) {
                next(errorResponseMessage.payloadIncorrect("Your payment receipt is required"));
                return;
            }
            await this.transactionService.uploadUserPaymentReceipt(
                req.params.id!, 
                req.file as Express.Multer.File, 
                res.locals?.user?.isVerified,
                res.locals?.user?._id?.toString(),
                req.ip,
                req.headers['user-agent']
            );

            return this.sendSuccess(res, {
                message: "Payment receipt uploaded successfully"
            })

        } catch (error: any) {
            return next(error);
        }
    }

    private async uploadAdminPaymentReceipt(req: Request, res: Response, next: NextFunction) {
        try {
            if(!req.file) {
                next(errorResponseMessage.payloadIncorrect("Alipay payment receipt is required"));
                return;
            }
            await this.transactionService.uploadAdminPaymentReceipt(
                req.params.id!, 
                req.file,
                res.locals?.user?._id?.toString(),
                req.ip,
                req.headers['user-agent']
            )
            return this.sendSuccess(res,  {
                message: "Alipay receipt uploaded successfully"
            })
        } catch (error: any) {
            return next(error);
        }
    }

    /**
     * Parse YYYY-MM-DD startDate/endDate query params into a Mongo-compatible
     * { $gte, $lte } range. Returns undefined if no valid dates are provided.
     */
    private buildDateRangeFilter(startDate: unknown, endDate: unknown): Record<string, Date> | undefined {
        const dateFilter: Record<string, Date> = {};

        if (typeof startDate === 'string') {
            const parts = startDate.split('-');
            if (parts.length === 3) {
                const year = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10) - 1;
                const day = parseInt(parts[2], 10);
                if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
                    dateFilter.$gte = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
                }
            }
        }

        if (typeof endDate === 'string') {
            const parts = endDate.split('-');
            if (parts.length === 3) {
                const year = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10) - 1;
                const day = parseInt(parts[2], 10);
                if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
                    dateFilter.$lte = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
                }
            }
        }

        return Object.keys(dateFilter).length > 0 ? dateFilter : undefined;
    }

    private async getAlipayTransactions(req: Request, res: Response, next: NextFunction, isAdmin: boolean) {
        try {
            const { page, limit, searchTerm, status, startDate, endDate } = req.query;
            const user = res.locals.user;

            // Build the filter from a strict whitelist — never spread req.query into a Mongo filter
            // (Express parses ?foo[$ne]=x into operator objects and would inject into the query).
            const filter: Record<string, unknown> = {
                currency: 'RMB',
            };

            if (!isAdmin) {
                filter.user = user?.id;
            }

            if (typeof status === 'string' && status && status !== 'all') {
                filter.status = status;
            }

            const createdAt = this.buildDateRangeFilter(startDate, endDate);
            if (createdAt) {
                filter.createdAt = createdAt;
            }

            const parsedPage = parseInt(page as string) || 1;
            const parsedLimit = parseInt(limit as string) || 10;

            const transactions = typeof searchTerm === 'string' && searchTerm
                ? await this.transactionService.searchTransactions(
                    searchTerm,
                    filter,
                    { page: parsedPage, limit: parsedLimit, useTextSearch: false }
                )
                : await this.transactionService.paginate(filter, {
                    page: parsedPage,
                    limit: parsedLimit,
                    sort: { createdAt: -1 },
                });

            return this.sendSuccess(res, transactions)
        } catch (error: any) {
            return next(error);
        }
    }

    private async getBankTransferTransactions(req: Request, res: Response, next: NextFunction, isAdmin: boolean) {
        try {
            const { page, limit, searchTerm, status, startDate, endDate } = req.query;
            const user = res.locals.user;

            // Build the filter from a strict whitelist — never spread req.query into a Mongo filter
            // (Express parses ?foo[$ne]=x into operator objects and would inject into the query).
            // Filter for bank transfer / YellowCard transactions (includes both send and receive).
            // Excludes RMB (alipay/wechat) which is served by a separate endpoint.
            const filter: Record<string, unknown> = {
                currency: {
                    $in: ['GHS', 'NGN', 'KES', 'XAF', 'ZAR', 'TZS', 'UGX', 'XOF', 'RWF', 'BWP', 'ZMW', 'MWK'],
                },
            };

            if (!isAdmin) {
                filter.user = user?.id;
            }

            if (typeof status === 'string' && status && status !== 'all') {
                filter.status = status;
            }

            const createdAt = this.buildDateRangeFilter(startDate, endDate);
            if (createdAt) {
                filter.createdAt = createdAt;
            }

            const parsedPage = parseInt(page as string) || 1;
            const parsedLimit = parseInt(limit as string) || 10;

            const transactions = typeof searchTerm === 'string' && searchTerm
                ? await this.transactionService.searchTransactions(
                    searchTerm,
                    filter,
                    { page: parsedPage, limit: parsedLimit, useTextSearch: false }
                )
                : await this.transactionService.paginate(filter, {
                    page: parsedPage,
                    limit: parsedLimit,
                    sort: { createdAt: -1 },
                });

            return this.sendSuccess(res, transactions)
        } catch (error: any) {
            return next(error);
        }
    }
}

export default new TransactionController().router;