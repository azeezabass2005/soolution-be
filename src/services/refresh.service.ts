import {ClientSession, Schema} from "mongoose";
import RefreshToken from '../models/refresh.model';
import DBService from "../utils/db.utils";
import { IRefreshToken } from "../models/interface";
import {TokenUtils} from "../utils/token.utils";

class RefreshTokenService extends DBService<IRefreshToken> {
    constructor() {
        super(RefreshToken);
    }

    async saveRefreshToken(
        userId: string,
        tokenId: string,
        userAgent?: string,
        ipAddress?: string,
        session?: ClientSession,
        expiresAt: Date = TokenUtils.getRefreshTokenExpiry()
    ): Promise<IRefreshToken> {
        return this.save({
            userId: (userId as unknown) as Schema.Types.ObjectId,
            token: tokenId,
            expiresAt,
            userAgent,
            ipAddress,
            isRevoked: false
        }, session);
    }

    async findValidToken(tokenId: string): Promise<IRefreshToken | null> {
        return this.findOne({
            token: tokenId,
            isRevoked: false,
            expiresAt: { $gt: new Date() }
        });
    }

    /**
     * Uses up a refresh token: marks it revoked and returns it, in one atomic
     * step so two requests can't both spend the same token. Null when it's
     * unknown, expired or already used.
     */
    async consumeToken(tokenId: string): Promise<IRefreshToken | null> {
        return RefreshToken.findOneAndUpdate(
            { token: tokenId, isRevoked: false, expiresAt: { $gt: new Date() } },
            { $set: { isRevoked: true, revokedAt: new Date() } },
            { new: false },
        );
    }

    /** The stored token whatever its state, to see why it couldn't be used */
    async findByTokenId(tokenId: string): Promise<IRefreshToken | null> {
        return RefreshToken.findOne({ token: tokenId });
    }

    async revokeToken(tokenId: string, session?: ClientSession): Promise<void> {
        await this.update(
            { token: tokenId },
            { isRevoked: true },
            session
        );
    }

    async revokeAllUserTokens(userId: any, session?: ClientSession): Promise<void> {
        await RefreshToken.updateMany(
            { userId: userId, isRevoked: false },
            { $set: { isRevoked: true, revokedAt: new Date() } },
            session ? { session } : {},
        );
    }
}

export default RefreshTokenService;