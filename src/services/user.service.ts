import userRepository, { type FindUserOptions, type NewUser, type UserUpdate } from "../repositories/user.repository";
import refreshTokenRepository from "../repositories/refresh-token.repository";
import type { User, UserTierHistoryEntry } from "../types/entities";
import type { UserTier } from "../common/tier.constants";
import { isUniqueViolation } from "../db/errors";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";

/** Users: lookup, registration, profile updates and sessions */
class UserService {
    async findById(id: string, options: FindUserOptions = {}): Promise<User | undefined> {
        return userRepository.findById(id, options);
    }

    async findByEmail(email: string, options: FindUserOptions = {}): Promise<User | undefined> {
        return userRepository.findByEmail(email, options);
    }

    /** The user an access token belongs to (its id and email must still match) */
    async findForSession(id: string, email: string): Promise<User | undefined> {
        return userRepository.findByIdAndEmail(id, email);
    }

    /** Creates the account; a duplicate email is a 409, even when two sign-ups race */
    async register(data: NewUser): Promise<User> {
        try {
            return await userRepository.create(data);
        } catch (error) {
            if (isUniqueViolation(error, "users_email_key")) {
                throw errorResponseMessage.createError(409, "User with this email already exists", ErrorSeverity.LOW);
            }
            throw error;
        }
    }

    /** Returns the updated user, or undefined if it doesn't exist */
    async update(id: string, patch: UserUpdate): Promise<User | undefined> {
        return userRepository.update(id, patch);
    }

    /** Admin list, newest first */
    async listAll(): Promise<User[]> {
        return userRepository.listAll();
    }

    /** Move the user to `tier`, recorded in their tier history */
    async setTier(id: string, tier: UserTier, reason: string, by?: string, extra?: UserUpdate): Promise<boolean> {
        return userRepository.setTier(id, tier, { reason, by }, { extra });
    }

    /** Oldest first, as the tier history array used to be stored */
    async tierHistory(id: string): Promise<UserTierHistoryEntry[]> {
        return (await userRepository.listTierHistory(id)).reverse();
    }

    /** Revoke every refresh token and refuse access tokens issued before now */
    async endAllSessions(id: string): Promise<void> {
        await refreshTokenRepository.revokeAllForUser(id);
        await userRepository.endAllSessions(id);
    }
}

export default UserService;
