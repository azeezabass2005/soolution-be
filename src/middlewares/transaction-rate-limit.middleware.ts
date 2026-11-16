import { Request, Response, NextFunction } from "express";
import errorResponseMessage from "../common/messages/error-response-message";
import transactionRepository from "../repositories/transaction.repository";
import { ErrorSeverity, ErrorResponseCode } from "../common/messages/error-response-message";

class TransactionRateLimitMiddleware {
    /**
     * Middleware to limit transaction creation per user and detect duplicates
     * Limits: 5 transactions per user per 15 minutes
     * Also checks for duplicate transactions (same amount, currency within 5 minutes)
     */
    checkTransactionRateLimit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const user = res.locals.user;
            const { amount, fromCurrency, toCurrency } = req.body;

            if (!user) {
                return next(errorResponseMessage.unauthorized());
            }

            const userId = String(user.id);
            const now = new Date();
            const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
            const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

            // Check transaction count in last 15 minutes
            const recentCount = await transactionRepository.countCreatedSince(userId, fifteenMinutesAgo);

            if (recentCount >= 5) {
                return next(errorResponseMessage.createError(
                    ErrorResponseCode.TOO_MANY_REQUESTS,
                    "Too many transactions. Please wait before creating another transaction.",
                    ErrorSeverity.HIGH
                ));
            }

            // Check for duplicate transactions (same amount, fromCurrency, toCurrency within 5 minutes)
            if (amount && fromCurrency && toCurrency) {
                const hasDuplicate = await transactionRepository.hasSimilarSince(
                    userId,
                    {
                        amount: Math.round(Number(amount) * 100) / 100, // Round to match stored amount
                        fromCurrency: String(fromCurrency).toUpperCase(),
                        currency: String(toCurrency).toUpperCase(),
                        statuses: ['pending_input', 'awaiting_kyc_verification', 'awaiting_confirmation', 'processing'],
                    },
                    fiveMinutesAgo
                );

                if (hasDuplicate) {
                    return next(errorResponseMessage.createError(
                        ErrorResponseCode.RESOURCE_ALREADY_EXISTS,
                        "A similar transaction was recently created. Please wait a few minutes before creating another transaction with the same details.",
                        ErrorSeverity.HIGH
                    ));
                }
            }

            next();
        } catch (error) {
            next(error);
        }
    };
}

export default new TransactionRateLimitMiddleware();
