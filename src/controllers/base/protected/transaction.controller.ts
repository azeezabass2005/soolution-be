import BaseController from "../base-controller";
import TransactionService, { type TransactionListFilter } from "../../../services/transaction.service";
import beneficiaryService from "../../../services/beneficiary.service";
import {Request, Response, NextFunction} from "express";
import errorResponseMessage, { ErrorSeverity } from "../../../common/messages/error-response-message";
import {validateCreateAlipayTransaction, validateCreateBankTransferTransaction} from "../../../validators/z-transaction";
import {ROLE_MAP, TRANSACTION_STATUS} from "../../../common/constant";
import RoleMiddleware from "../../../middlewares/role.middleware";
import TransactionMiddleware from "../../../middlewares/transaction.middleware";
import TransactionRateLimitMiddleware from "../../../middlewares/transaction-rate-limit.middleware";
import ReceiptFileValidationMiddleware from "../../../middlewares/receipt-file-validation.middleware";
import {MulterMiddleware} from "../../../middlewares/multer.middleware";
import receiptService from "../../../services/receipt.service";

import transactionLimitService from "../../../services/transaction-limit.service";

/** Lagos is UTC+1 all year */
const WAT_OFFSET_MS = 60 * 60 * 1000;

class TransactionController extends BaseController {

    private transactionService: TransactionService;

    constructor() {
        super();
        this.transactionService = new TransactionService();
        this.setupRoutes()
    }

    protected setupRoutes() {
        // Mint (or fetch) the opaque token that backs this transaction's
        // public receipt verification page. Owner-only; see receipt.service.
        this.router.post("/:id/receipt-token", this.getReceiptToken.bind(this));

        // Admin: reject a manual payment that hasn't been paid out (wallet payments are refunded)
        this.router.patch("/:id/reject", RoleMiddleware.isAdmin, this.rejectTransaction.bind(this));

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
            const token = await receiptService.getOrCreateToken(req.params.id, user.id);
            return this.sendSuccess(res, { token });
        } catch (error) {
            return next(error);
        }
    }

    private async createAlipayTransaction(req: Request, res: Response, next: NextFunction) {
        try {
            const transactionData = req.body as Record<string, any>;

            // Extract idempotency key from header if not in body
            const idempotencyKey = transactionData.idempotencyKey || req.headers['idempotency-key'] as string;

            const user = res.locals.user;

            // A saved beneficiary supplies the recipient and its stored QR code
            const beneficiaryId = (req.body as any)?.beneficiaryId;
            let savedQrCodeUrl: string | undefined;
            if (beneficiaryId) {
                const beneficiary = await beneficiaryService.getOwned(user.id, String(beneficiaryId));
                if (beneficiary.currency !== "RMB" || beneficiary.kind !== transactionData.paymentMethod || !beneficiary.qrCodeUrl) {
                    next(errorResponseMessage.payloadIncorrect("This beneficiary can't receive this payment method"));
                    return;
                }
                transactionData.alipayNo = beneficiary.alipayNo;
                transactionData.alipayName = beneficiary.alipayName;
                if (beneficiary.kind === "alipay") (transactionData as any).platform = beneficiary.alipayType;
                savedQrCodeUrl = beneficiary.qrCodeUrl;
            }

            if(!req.file && !savedQrCodeUrl) {
                next(errorResponseMessage.payloadIncorrect("Alipay Qrcode"));
                return;
            }

            const transaction = await transactionLimitService.withUserLock(user.id, () => this.transactionService.createAlipayTransaction(
                { ...transactionData, idempotencyKey },
                req.file ?? { qrCodeUrl: savedQrCodeUrl! },
                user.id,
                req.ip,
                req.headers['user-agent']
            ))

            return this.sendSuccess(res, {
                transaction,
                message: (transaction as any)?.details?.fundingCurrency
                    ? 'Payment submitted. We\'ll pay your recipient and send you a receipt.'
                    : 'Transaction initiated successfully, please proceed to pay into the provided account number.'
            })
        } catch (error: any) {
            return next(error);
        }
    }

    private async createBankTransferTransaction(req: Request, res: Response, next: NextFunction) {
        try {
            const transactionData = req.body as Record<string, any>;

            // Extract idempotency key from header if not in body
            const idempotencyKey = transactionData.idempotencyKey || req.headers['idempotency-key'] as string;

            const user = res.locals.user;

            const transaction = await transactionLimitService.withUserLock(user.id, () => this.transactionService.createBankTransferTransaction(
                { ...transactionData, idempotencyKey },
                user.id,
                req.ip,
                req.headers['user-agent']
            ))

            return this.sendSuccess(res, {
                transaction,
                message: (transaction as any)?.details?.fundingCurrency
                    ? 'Payment submitted. We\'ll pay your recipient and send you a receipt.'
                    : 'Transaction initiated successfully, please proceed to pay into the provided account number.'
            })
        } catch (error: any) {
            return next(error);
        }
    }

    private async rejectTransaction(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await this.transactionService.rejectManualTransaction(
                req.params.id,
                req.body?.reason,
                String(res.locals.user?.id),
                req.ip,
                req.headers['user-agent']
            );
            return this.sendSuccess(res, {
                ...result,
                message: result.refundedToWallet ? 'Payment rejected and refunded to the user\'s wallet' : 'Payment rejected',
            });
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
            const { status } = await this.transactionService.uploadUserPaymentReceipt(
                req.params.id!, 
                req.file as Express.Multer.File, 
                res.locals?.user?.id,
                req.ip,
                req.headers['user-agent']
            );

            return this.sendSuccess(res, {
                message: "Payment receipt uploaded successfully",
                status
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
                res.locals?.user?.id,
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
     * Parse YYYY-MM-DD startDate/endDate query params into a { from, to } range
     * of whole days in Lagos time (WAT, UTC+1), so "today" is the user's today.
     * Returns undefined if no valid dates are provided.
     */
    private buildDateRangeFilter(startDate: unknown, endDate: unknown): { from?: Date; to?: Date } | undefined {
        const dateFilter: { from?: Date; to?: Date } = {};

        if (typeof startDate === 'string') {
            const parts = startDate.split('-');
            if (parts.length === 3) {
                const year = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10) - 1;
                const day = parseInt(parts[2], 10);
                if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
                    dateFilter.from = new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - WAT_OFFSET_MS);
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
                    dateFilter.to = new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - WAT_OFFSET_MS);
                }
            }
        }

        return Object.keys(dateFilter).length > 0 ? dateFilter : undefined;
    }

    /** The user id an admin filtered by, if it's a well-formed id */
    private adminUserFilter(value: unknown): string | undefined {
        if (typeof value !== "string" || !value) return undefined;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
            throw errorResponseMessage.createError(400, "user must be a user id", ErrorSeverity.LOW);
        }
        return value;
    }

    private async getAlipayTransactions(req: Request, res: Response, next: NextFunction, isAdmin: boolean) {
        try {
            const { page, limit, searchTerm, status, startDate, endDate } = req.query;
            const user = res.locals.user;

            // Build the filter from a strict whitelist — never pass req.query straight to the database
            const filter: TransactionListFilter = { currency: 'RMB' };

            // Users see only their own; an admin can narrow to one user (?user=<id>)
            filter.user = isAdmin ? this.adminUserFilter(req.query.user) : user?.id;

            if (typeof status === 'string' && status && status !== 'all') {
                filter.status = status;
            }

            const createdAt = this.buildDateRangeFilter(startDate, endDate);
            filter.createdFrom = createdAt?.from;
            filter.createdTo = createdAt?.to;

            const transactions = await this.transactionService.listTransactions(
                filter,
                { page: parseInt(page as string) || 1, limit: parseInt(limit as string) || 10 },
                typeof searchTerm === 'string' ? searchTerm : undefined
            );

            return this.sendSuccess(res, transactions)
        } catch (error: any) {
            return next(error);
        }
    }

    private async getBankTransferTransactions(req: Request, res: Response, next: NextFunction, isAdmin: boolean) {
        try {
            const { page, limit, searchTerm, status, startDate, endDate } = req.query;
            const user = res.locals.user;

            // Build the filter from a strict whitelist — never pass req.query straight to the database.
            // Bank transfer / YellowCard / OGateway transactions (send and receive); RMB (alipay/wechat)
            // is served by a separate endpoint.
            const filter: TransactionListFilter = {
                currency: ['GHS', 'NGN', 'KES', 'XAF', 'ZAR', 'TZS', 'UGX', 'XOF', 'RWF', 'BWP', 'ZMW', 'MWK'],
            };

            // Users see only their own; an admin can narrow to one user (?user=<id>)
            filter.user = isAdmin ? this.adminUserFilter(req.query.user) : user?.id;

            if (typeof status === 'string' && status && status !== 'all') {
                filter.status = status;
            }

            const createdAt = this.buildDateRangeFilter(startDate, endDate);
            filter.createdFrom = createdAt?.from;
            filter.createdTo = createdAt?.to;

            const transactions = await this.transactionService.listTransactions(
                filter,
                { page: parseInt(page as string) || 1, limit: parseInt(limit as string) || 10 },
                typeof searchTerm === 'string' ? searchTerm : undefined
            );

            return this.sendSuccess(res, transactions)
        } catch (error: any) {
            return next(error);
        }
    }
}

export default new TransactionController().router;