import { and, eq, gt } from "drizzle-orm";
import { refreshTokens } from "../db/schema";
import type { Executor } from "../db/client";
import type { RefreshToken } from "../types/entities";
import { exec, isUuid, stripNulls } from "./utils";

export type NewRefreshToken = typeof refreshTokens.$inferInsert;

class RefreshTokenRepository {
    async create(data: NewRefreshToken, tx?: Executor): Promise<RefreshToken> {
        const [row] = await exec(tx).insert(refreshTokens).values(data).returning();
        return stripNulls(row);
    }

    /** Unrevoked and unexpired */
    async findValid(token: string): Promise<RefreshToken | undefined> {
        const [row] = await exec()
            .select()
            .from(refreshTokens)
            .where(and(eq(refreshTokens.token, token), eq(refreshTokens.isRevoked, false), gt(refreshTokens.expiresAt, new Date())))
            .limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findByToken(token: string): Promise<RefreshToken | undefined> {
        const [row] = await exec().select().from(refreshTokens).where(eq(refreshTokens.token, token)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /**
     * Spend a token: revoke it and return it as it was, in one statement, so two
     * requests can't both use it. Undefined when unknown, expired or already used.
     */
    async consume(token: string): Promise<RefreshToken | undefined> {
        const [row] = await exec()
            .update(refreshTokens)
            .set({ isRevoked: true, revokedAt: new Date() })
            .where(and(eq(refreshTokens.token, token), eq(refreshTokens.isRevoked, false), gt(refreshTokens.expiresAt, new Date())))
            .returning();
        // The caller gets the token as it was before it was spent
        return row ? stripNulls({ ...row, isRevoked: false, revokedAt: null }) : undefined;
    }

    async revoke(token: string, tx?: Executor): Promise<void> {
        await exec(tx).update(refreshTokens).set({ isRevoked: true }).where(eq(refreshTokens.token, token));
    }

    async revokeAllForUser(userId: string, tx?: Executor): Promise<void> {
        if (!isUuid(userId)) return;
        await exec(tx)
            .update(refreshTokens)
            .set({ isRevoked: true, revokedAt: new Date() })
            .where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.isRevoked, false)));
    }
}

export const refreshTokenRepository = new RefreshTokenRepository();
export default refreshTokenRepository;
