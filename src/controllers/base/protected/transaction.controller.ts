import BaseController from "../base-controller";
import TransactionService from "../../../services/transaction.service";
import {Request, Response, NextFunction} from "express";
import {DetailType, ITransaction, ITransactionDetail} from "../../../models/interface";
import errorResponseMessage from "../../../common/messages/error-response-message";
import {validateCreateAlipayTransaction} from "../../../validators/z-transaction";
import {ROLE_MAP, TRANSACTION_STATUS} from "../../../common/constant";
import RoleMiddleware from "../../../middlewares/role.middleware";
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
        this.router.post("/alipay", MulterMiddleware.single('alipayQrCode'), MulterMiddleware.handleError, validateCreateAlipayTransaction, this.createAlipayTransaction.bind(this));

        // Route for user to get alipay transactions
        this.router.get("/alipay", (req: Request, res: Response, next: NextFunction) => this.getAlipayTransactions(req, res, next, false));

        // Route for user to get alipay transactions
        this.router.get("/alipay-admin", RoleMiddleware.isAdmin, (req: Request, res: Response, next: NextFunction) => this.getAlipayTransactions(req, res, next, true));

        // Route for user to upload payment receipt
        this.router.patch("/alipay/user-receipt/:id", MulterMiddleware.single('receipt'), MulterMiddleware.handleError, this.uploadUserPaymentReceipt.bind(this));

        // Route for admin to upload payment receipt
        this.router.patch("/alipay/admin-receipt/:id", RoleMiddleware.isAdmin, MulterMiddleware.single('receipt'), MulterMiddleware.handleError, this.uploadAdminPaymentReceipt.bind(this));
    }

    private async createAlipayTransaction(req: Request, res: Response, next: NextFunction) {
        try {
            const transactionData: Partial<ITransaction & ITransactionDetail & { paymentMethod: DetailType }> = req.body;

            const user = res.locals.user;

            if(!req.file) {
                next(errorResponseMessage.payloadIncorrect("Alipay Qrcode"));
                return;
            }

            const transaction = await this.transactionService.createAlipayTransaction(
                transactionData,
                req.file as Express.Multer.File,
                user._id!,
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
            await this.transactionService.uploadUserPaymentReceipt(req.params.id!, req.file as Express.Multer.File, res.locals?.user?.isVerified);

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
            await this.transactionService.uploadAdminPaymentReceipt(req.params.id!, req.file)
            return this.sendSuccess(res,  {
                message: "Alipay receipt uploaded successfully"
            })
        } catch (error: any) {
            return next(error);
        }
    }

    private async getAlipayTransactions(req: Request, res: Response, next: NextFunction, isAdmin: boolean) {
        try {
            const { page, limit, searchTerm, status, ...otherQueries } = req.query;
            const user = res.locals.user;

            if (!isAdmin) {
                otherQueries.user = user?.id;
            }

            // Handle status filter
            if (status && status !== 'all') {
                otherQueries.status = status;
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