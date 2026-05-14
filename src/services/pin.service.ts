import DBService from "../utils/db.utils";
import { IUser } from "../models/interface";
import User from "../models/user.model";
import HashService from "../utils/hash.utils";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { WALLET_LIMITS } from "../config/wallet-limits.config";
import TokenBuilder from "../utils/token.utils";
import { TokenType } from "../utils/interface";
import logger from "../utils/logger.utils";

/**
 * Single source of truth for transaction-PIN operations.
 *
 * The PIN lives on the user document (transactionPinHash, isTransactionPinSet,
 * transactionPinAttempts, transactionPinLockedUntil) and is required to
 * authorize any outbound money movement. WalletService.{setPin,changePin,
 * verifyPin} delegate here so wallet withdrawal continues to work unchanged.
 */
class PinService extends DBService<IUser> {
    private tokenBuilder: TokenBuilder;

    constructor() {
        super(User);
        this.tokenBuilder = new TokenBuilder();
    }

    /**
     * Set the user's transaction PIN for the first time.
     * Throws 400 if a PIN is already set — the caller must use changePin instead.
     */
    async setPin(userId: string, pin: string): Promise<void> {
        const user = await this.Model.findById(userId).select('+transactionPinHash');
        if (!user) throw errorResponseMessage.resourceNotFound("User");

        if (user.isTransactionPinSet) {
            throw errorResponseMessage.createError(400, "PIN is already set. Use change PIN instead.", ErrorSeverity.MEDIUM);
        }

        const { password: transactionPinHash } = await HashService.hashPassword(pin);
        await this.Model.updateOne(
            { _id: userId },
            {
                transactionPinHash,
                isTransactionPinSet: true,
                transactionPinAttempts: 0,
                $unset: { transactionPinLockedUntil: 1 },
            }
        );
    }

    /**
     * Change an existing PIN. Verifies the old PIN (with lockout) before re-hashing.
     */
    async changePin(userId: string, oldPin: string, newPin: string): Promise<void> {
        await this.verifyPin(userId, oldPin);

        const { password: transactionPinHash } = await HashService.hashPassword(newPin);
        await this.Model.updateOne(
            { _id: userId },
            {
                transactionPinHash,
                transactionPinAttempts: 0,
                $unset: { transactionPinLockedUntil: 1 },
            }
        );
    }

    /**
     * Verify a PIN and enforce lockout.
     * - Increments transactionPinAttempts on failure.
     * - Locks the account for PIN_LOCKOUT_MINUTES after MAX_PIN_ATTEMPTS.
     * - Resets the counter on success.
     * Throws on any failure mode (no PIN set, locked, wrong, etc).
     */
    async verifyPin(userId: string, pin: string): Promise<void> {
        const user = await this.Model.findById(userId).select('+transactionPinHash');
        if (!user) throw errorResponseMessage.resourceNotFound("User");

        if (!user.isTransactionPinSet || !user.transactionPinHash) {
            throw errorResponseMessage.createError(400, "Transaction PIN has not been set yet.", ErrorSeverity.MEDIUM);
        }

        if (user.transactionPinLockedUntil && user.transactionPinLockedUntil.getTime() > Date.now()) {
            const remainingMinutes = Math.ceil((user.transactionPinLockedUntil.getTime() - Date.now()) / 60000);
            throw errorResponseMessage.createError(
                429,
                `Transaction PIN is locked. Try again in ${remainingMinutes} minute(s).`,
                ErrorSeverity.HIGH
            );
        }

        const isValid = await HashService.verifyPassword(pin, user.transactionPinHash);
        if (!isValid) {
            const attempts = (user.transactionPinAttempts || 0) + 1;
            const updates: any = { transactionPinAttempts: attempts };

            if (attempts >= WALLET_LIMITS.MAX_PIN_ATTEMPTS) {
                updates.transactionPinLockedUntil = new Date(Date.now() + WALLET_LIMITS.PIN_LOCKOUT_MINUTES * 60 * 1000);
                updates.transactionPinAttempts = 0;
                logger.warn("Transaction PIN locked", { userId, attempts });
            }

            await this.Model.updateOne({ _id: userId }, updates);

            const remaining = WALLET_LIMITS.MAX_PIN_ATTEMPTS - attempts;
            throw errorResponseMessage.createError(
                401,
                remaining > 0
                    ? `Incorrect PIN. ${remaining} attempt(s) remaining.`
                    : `Too many incorrect attempts. PIN locked for ${WALLET_LIMITS.PIN_LOCKOUT_MINUTES} minutes.`,
                ErrorSeverity.HIGH
            );
        }

        // Reset attempts on success
        if ((user.transactionPinAttempts || 0) > 0) {
            await this.Model.updateOne(
                { _id: userId },
                { transactionPinAttempts: 0, $unset: { transactionPinLockedUntil: 1 } }
            );
        }
    }

    /**
     * Clear the user's PIN (used by reset flow). Re-set is required afterwards.
     */
    async clearPin(userId: string): Promise<void> {
        await this.Model.updateOne(
            { _id: userId },
            {
                $unset: { transactionPinHash: 1, transactionPinLockedUntil: 1 },
                isTransactionPinSet: false,
                transactionPinAttempts: 0,
            }
        );
    }

    /**
     * Issue a short-lived RESET_PIN JWT for the given email. Returns null if no
     * user exists — callers should still respond with a generic success message
     * to avoid account enumeration.
     */
    async issueResetToken(email: string): Promise<string | null> {
        const user = await this.findOne({ email });
        if (!user) return null;

        // Sign a RESET_PIN token using the same TokenBuilder pattern as auth flows.
        // 30-minute expiry per plan.
        return this.tokenBuilder.build().createToken(user, {
            type: TokenType.RESET_PIN,
            expiresIn: '30m',
        });
    }

    /**
     * Validate a RESET_PIN token and set the new PIN. Clears any lockout.
     */
    async resetWithToken(token: string, newPin: string): Promise<void> {
        const decoded = await this.tokenBuilder.setToken(token).build().verifyToken();

        if (!decoded || decoded.type !== TokenType.RESET_PIN) {
            throw errorResponseMessage.unauthorized("Invalid or expired PIN reset token");
        }

        const userId = decoded.data?.userId;
        if (!userId) {
            throw errorResponseMessage.unauthorized("Invalid PIN reset token payload");
        }

        const user = await this.findById(userId);
        if (!user) throw errorResponseMessage.resourceNotFound("User");

        const { password: transactionPinHash } = await HashService.hashPassword(newPin);
        await this.Model.updateOne(
            { _id: userId },
            {
                transactionPinHash,
                isTransactionPinSet: true,
                transactionPinAttempts: 0,
                $unset: { transactionPinLockedUntil: 1 },
            }
        );

        logger.info("Transaction PIN reset successfully", { userId });
    }

    /**
     * Status snapshot for the frontend pre-flight check.
     */
    async getStatus(userId: string): Promise<{ isTransactionPinSet: boolean; isLocked: boolean; lockedUntil?: Date }> {
        const user = await this.findById(userId);
        if (!user) throw errorResponseMessage.resourceNotFound("User");

        const lockedUntil = user.transactionPinLockedUntil;
        const isLocked = !!(lockedUntil && lockedUntil.getTime() > Date.now());

        return {
            isTransactionPinSet: !!user.isTransactionPinSet,
            isLocked,
            lockedUntil: isLocked ? lockedUntil : undefined,
        };
    }
}

export default PinService;
