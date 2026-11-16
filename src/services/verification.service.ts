import verificationRepository from "../repositories/verification.repository";
import type { Verification } from "../types/entities";

class VerificationService {
    /** The user's most recent identity check (never the encrypted numbers or hashes) */
    async latestForUser(userId: string): Promise<Verification | undefined> {
        return verificationRepository.latestForUser(userId);
    }
}

export default VerificationService;
