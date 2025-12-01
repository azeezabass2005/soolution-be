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
        session?: ClientSession
    ): Promise<IRefreshToken> {

        console.log("RefreshTokenService saveRefreshToken", tokenId, userAgent, ipAddress, session);

        return this.save({
            userId: (userId as unknown) as Schema.Types.ObjectId,
            token: tokenId,
            expiresAt: TokenUtils.getRefreshTokenExpiry(),
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

    async revokeToken(tokenId: string, session?: ClientSession): Promise<void> {
        await this.update(
            { token: tokenId },
            { isRevoked: true },
            session
        );
    }

    async revokeAllUserTokens(userId: any, session?: ClientSession): Promise<void> {

        console.log(userId, "This is the userid received by the revokeAllUserTokens")

        await this.update(
            { userId: userId, isRevoked: false },
            { isRevoked: true },
            session
        );
    }
}

export default RefreshTokenService;