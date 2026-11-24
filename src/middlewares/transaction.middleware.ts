import { Request, Response, NextFunction } from "express";
import errorResponseMessage, { ErrorResponse, ErrorSeverity } from "../common/messages/error-response-message";
import { ROLE_MAP } from "../common/constant";
import transactionRepository from "../repositories/transaction.repository";
import { allowed } from "./role.middleware";

class TransactionMiddleware {

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

            // Admins who handle transactions can act on anyone's
            if (user.role === ROLE_MAP.ADMIN && (await allowed(res, "transactions"))) {
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
            const transaction = await transactionRepository.findById(transactionId);

            if (!transaction) {
                return next(errorResponseMessage.resourceNotFound("Transaction"));
            }

            // Check if user is the owner
            if (String(user.id) !== transaction.user) {
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
