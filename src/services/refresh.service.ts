import refreshTokenRepository from "../repositories/refresh-token.repository";
import type { RefreshToken } from "../types/entities";
import type { Executor } from "../db/client";
import { TokenUtils } from "../utils/token.utils";

class RefreshTokenService {
    async saveRefreshToken(
        userId: string,
        tokenId: string,
        userAgent?: string,
        ipAddress?: string,
        tx?: Executor,
        expiresAt: Date = TokenUtils.getRefreshTokenExpiry()
    ): Promise<RefreshToken> {
        return refreshTokenRepository.create({ userId, token: tokenId, expiresAt, userAgent, ipAddress, isRevoked: false }, tx);
    }

    async findValidToken(tokenId: string): Promise<RefreshToken | undefined> {
        return refreshTokenRepository.findValid(tokenId);
    }

    /**
     * Uses up a refresh token: marks it revoked and returns it, in one atomic
     * step so two requests can't both spend the same token. Undefined when it's
     * unknown, expired or already used.
     */
    async consumeToken(tokenId: string): Promise<RefreshToken | undefined> {
        return refreshTokenRepository.consume(tokenId);
    }

    /** The stored token whatever its state, to see why it couldn't be used */
    async findByTokenId(tokenId: string): Promise<RefreshToken | undefined> {
        return refreshTokenRepository.findByToken(tokenId);
    }

    async revokeToken(tokenId: string, tx?: Executor): Promise<void> {
        await refreshTokenRepository.revoke(tokenId, tx);
    }

    async revokeAllUserTokens(userId: string, tx?: Executor): Promise<void> {
        await refreshTokenRepository.revokeAllForUser(String(userId), tx);
    }
}

export default RefreshTokenService;
