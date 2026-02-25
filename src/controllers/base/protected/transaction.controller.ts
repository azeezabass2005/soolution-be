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

class TransactionController extends BaseController {

    private transactionService: TransactionService;

    constructor() {
        super();
        this.transactionService = new TransactionService(['details', 'user']);
        this.setupRoutes()
    }

    protected setupRoutes() {
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

    private async createAlipayTransaction(req: Request, res: Response, next: NextFunction) {
        try {
            const transactionData: Partial<ITransaction & ITransactionDetail & { paymentMethod: DetailType; idempotencyKey?: string }> = req.body;
            
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
            const transactionData: Partial<ITransaction & ITransactionDetail & { paymentMethod: DetailType; toCurrency: string; institutionType: string; idempotencyKey?: string }> = req.body;
            
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

    private async getAlipayTransactions(req: Request, res: Response, next: NextFunction, isAdmin: boolean) {
        try {
            const { page, limit, searchTerm, status, startDate, endDate, ...otherQueries } = req.query;
            const user = res.locals.user;

            if (!isAdmin) {
                otherQueries.user = user?.id;
            }

            // Filter for RMB transactions only
            otherQueries.currency = 'RMB';

            // Handle status filter
            if (status && status !== 'all') {
                otherQueries.status = status;
            }

            // Handle date range filter
            if (startDate || endDate) {
                const dateFilter: any = {};
                if (startDate) {
                    // Parse date string (YYYY-MM-DD) and create start of day in UTC
                    const dateParts = (startDate as string).split('-');
                    if (dateParts.length === 3) {
                        const year = parseInt(dateParts[0], 10);
                        const month = parseInt(dateParts[1], 10) - 1; // Month is 0-indexed
                        const day = parseInt(dateParts[2], 10);
                        // Create date in UTC to avoid timezone issues
                        const start = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
                        dateFilter.$gte = start;
                    }
                }
                if (endDate) {
                    // Parse date string (YYYY-MM-DD) and create end of day in UTC
                    const dateParts = (endDate as string).split('-');
                    if (dateParts.length === 3) {
                        const year = parseInt(dateParts[0], 10);
                        const month = parseInt(dateParts[1], 10) - 1; // Month is 0-indexed
                        const day = parseInt(dateParts[2], 10);
                        // Create date in UTC to avoid timezone issues
                        const end = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
                        dateFilter.$lte = end;
                    }
                }
                if (Object.keys(dateFilter).length > 0) {
                    otherQueries.createdAt = dateFilter;
                }
            }

            let transactions;

            if (searchTerm) {
                transactions = await this.transactionService.searchTransactions(
                    searchTerm.toString(),
                    otherQueries,
                    {
                        page: parseInt(page as string) || 1,
                        limit: parseInt(limit as string) || 10,
                        useTextSearch: false
                    }
                );
            } else {
                transactions = await this.transactionService.paginate(otherQueries, {
                    page: parseInt(page as string) || 1,
                    limit: parseInt(limit as string) || 10,
                    sort: { createdAt: -1 }
                });
            }

            return this.sendSuccess(res, transactions)
        } catch (error: any) {
            return next(error);
        }
    }

    private async getBankTransferTransactions(req: Request, res: Response, next: NextFunction, isAdmin: boolean) {
        try {
            const { page, limit, searchTerm, status, startDate, endDate, ...otherQueries } = req.query;
            const user = res.locals.user;

            if (!isAdmin) {
                otherQueries.user = user?.id;
            }

            // Filter for bank transfer transactions (includes both send and receive)
            // Send: fromCurrency = NGN/GHS, currency = GHS/XAF/KES
            // Receive: fromCurrency = GHS/KES/XAF/NGN, currency = NGN/GHS
            otherQueries.currency = { $in: ['GHS', 'XAF', 'KES', 'NGN'] };

            // Handle status filter
            if (status && status !== 'all') {
                otherQueries.status = status;
            }

            // Handle date range filter
            if (startDate || endDate) {
                const dateFilter: any = {};
                if (startDate) {
                    // Parse date string (YYYY-MM-DD) and create start of day in UTC
                    const dateParts = (startDate as string).split('-');
                    if (dateParts.length === 3) {
                        const year = parseInt(dateParts[0], 10);
                        const month = parseInt(dateParts[1], 10) - 1; // Month is 0-indexed
                        const day = parseInt(dateParts[2], 10);
                        // Create date in UTC to avoid timezone issues
                        const start = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
                        dateFilter.$gte = start;
                    }
                }
                if (endDate) {
                    // Parse date string (YYYY-MM-DD) and create end of day in UTC
                    const dateParts = (endDate as string).split('-');
                    if (dateParts.length === 3) {
                        const year = parseInt(dateParts[0], 10);
                        const month = parseInt(dateParts[1], 10) - 1; // Month is 0-indexed
                        const day = parseInt(dateParts[2], 10);
                        // Create date in UTC to avoid timezone issues
                        const end = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
                        dateFilter.$lte = end;
                    }
                }
                if (Object.keys(dateFilter).length > 0) {
                    otherQueries.createdAt = dateFilter;
                }
            }

            let transactions;

            if (searchTerm) {
                transactions = await this.transactionService.searchTransactions(
                    searchTerm.toString(),
                    otherQueries,
                    {
                        page: parseInt(page as string) || 1,
                        limit: parseInt(limit as string) || 10,
                        useTextSearch: false
                    }
                );
            } else {
                transactions = await this.transactionService.paginate(otherQueries, {
                    page: parseInt(page as string) || 1,
                    limit: parseInt(limit as string) || 10,
                    sort: { createdAt: -1 }
                });
            }

            return this.sendSuccess(res, transactions)
        } catch (error: any) {
            return next(error);
        }
    }
}

export default new TransactionController().router;