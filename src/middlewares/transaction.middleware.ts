import { Request, Response, NextFunction } from "express";
import errorResponseMessage, { ErrorResponse, ErrorSeverity } from "../common/messages/error-response-message";
import { ROLE_MAP } from "../common/constant";
import TransactionService from "../services/transaction.service";

class TransactionMiddleware {
    private transactionService: TransactionService;

    constructor() {
        this.transactionService = new TransactionService(['user']);
    }

    /**
     * Verifies that the user owns the transaction or is an admin
     * @param req Express request object
     * @param res Express response object
     * @param next Next middleware function
     */
    verifyOwnership = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const user = res.locals.user;
            const transactionId = req.params.id;

            if (!user) {
                return next(errorResponseMessage.unauthorized());
            }

            // If user is admin, allow access
            if (user.role === ROLE_MAP.ADMIN) {
                return next();
            }

            if (!transactionId) {
                return next(errorResponseMessage.createError(
                    400,
                    "Transaction ID is required",
                    ErrorSeverity.HIGH
                ));
            }

            // Fetch transaction to verify ownership
            const transaction = await this.transactionService.findById(transactionId);

            if (!transaction) {
                return next(errorResponseMessage.resourceNotFound("Transaction"));
            }

            // Check if user is the owner
            const transactionUserId = typeof transaction.user === 'object' && transaction.user !== null
                ? (transaction.user as any)._id?.toString() || (transaction.user as any).toString()
                : transaction.user.toString();

            if (user._id.toString() !== transactionUserId) {
                return next(errorResponseMessage.createError(
                    403,
                    "You don't have permission to perform this action on this transaction",
                    ErrorSeverity.HIGH
                ));
            }

            // Attach transaction to request for use in controllers
            res.locals.transaction = transaction;

            next();
        } catch (error) {
            next(error);
        }
    };
}

export default new TransactionMiddleware();
