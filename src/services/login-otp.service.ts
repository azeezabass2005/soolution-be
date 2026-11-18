import crypto from "crypto";
import { and, count, eq, gt, gte, isNull, lt, sql } from "drizzle-orm";
import { loginChallenges } from "../db/schema";
import { exec, isUuid } from "../repositories/utils";
import config from "../config/env.config";

/** How long a code works */
export const LOGIN_OTP_TTL_MS = 10 * 60 * 1000;
/** Wrong codes allowed before the code stops working */
export const LOGIN_OTP_MAX_ATTEMPTS = 5;
/** Wait between "send a new code" */
export const LOGIN_OTP_RESEND_MS = 60 * 1000;
/** Codes per sign-in, the first one included */
export const LOGIN_OTP_MAX_SENDS = 5;
/** Sign-ins (each emails a code) per account per hour */
export const LOGIN_OTP_MAX_PER_HOUR = 10;

export type LoginChallenge = typeof loginChallenges.$inferSelect;

export class LoginOtpError extends Error {
    constructor(
        public code: "CHALLENGE_INVALID" | "CODE_EXPIRED" | "CODE_WRONG" | "TOO_MANY_ATTEMPTS" | "RESEND_TOO_SOON" | "TOO_MANY_CODES",
        message: string,
        public status: number,
        public extra: Record<string, unknown> = {}
    ) {
        super(message);
    }
}

const hashCode = (challengeId: string, code: string) =>
    crypto.createHmac("sha256", config.JWT_SECRET).update(`login-otp:${challengeId}:${code}`).digest("hex");

const newCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

const sameHash = (a: string, b: string) => {
    const x = Buffer.from(a, "hex");
    const y = Buffer.from(b, "hex");
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Email codes for signing in. A challenge is opened once the password is
 * right; the session is only issued when its code is entered. Codes are
 * hashed, expire, allow a few wrong tries, and work once.
 */
class LoginOtpService {
    /** Opens a challenge (closing the user's earlier open ones) and returns it with its code */
    async start(userId: string, meta: { rememberMe: boolean; ipAddress?: string; userAgent?: string }): Promise<{ challenge: LoginChallenge; code: string }> {
        const [recent] = await exec()
            .select({ n: count() })
            .from(loginChallenges)
            .where(and(eq(loginChallenges.userId, userId), gte(loginChallenges.createdAt, new Date(Date.now() - 60 * 60 * 1000))));
        if (Number(recent?.n ?? 0) >= LOGIN_OTP_MAX_PER_HOUR) {
            throw new LoginOtpError("TOO_MANY_CODES", "Too many sign-in attempts. Please wait an hour and try again.", 429);
        }

        // Only the newest sign-in's code works
        await exec()
            .update(loginChallenges)
            .set({ consumedAt: new Date() })
            .where(and(eq(loginChallenges.userId, userId), isNull(loginChallenges.consumedAt)));

        const id = crypto.randomUUID();
        const code = newCode();
        const [challenge] = await exec()
            .insert(loginChallenges)
            .values({
                id,
                userId,
                codeHash: hashCode(id, code),
                expiresAt: new Date(Date.now() + LOGIN_OTP_TTL_MS),
                rememberMe: meta.rememberMe,
                ipAddress: meta.ipAddress,
                userAgent: meta.userAgent?.slice(0, 500),
            })
            .returning();
        return { challenge, code };
    }

    /** A fresh code for an open challenge (the old one stops working) */
    async resend(challengeId: string): Promise<{ challenge: LoginChallenge; code: string }> {
        const challenge = await this.findOpen(challengeId);
        const waitMs = new Date(challenge.lastSentAt).getTime() + LOGIN_OTP_RESEND_MS - Date.now();
        if (waitMs > 0) {
            const seconds = Math.ceil(waitMs / 1000);
            throw new LoginOtpError("RESEND_TOO_SOON", `You can ask for a new code in ${seconds} seconds.`, 429, { retryAfterSeconds: seconds });
        }
        if (challenge.sendCount >= LOGIN_OTP_MAX_SENDS) {
            throw new LoginOtpError("TOO_MANY_CODES", "We've sent too many codes for this sign-in. Please sign in again.", 429);
        }
        const code = newCode();
        const [updated] = await exec()
            .update(loginChallenges)
            .set({
                codeHash: hashCode(challenge.id, code),
                expiresAt: new Date(Date.now() + LOGIN_OTP_TTL_MS),
                attempts: 0,
                sendCount: sql`${loginChallenges.sendCount} + 1`,
                lastSentAt: new Date(),
                updatedAt: new Date(),
            })
            // Unchanged since it was read, so two clicks can't both send
            .where(and(eq(loginChallenges.id, challenge.id), isNull(loginChallenges.consumedAt), eq(loginChallenges.sendCount, challenge.sendCount)))
            .returning();
        if (!updated) {
            throw new LoginOtpError("RESEND_TOO_SOON", "A new code is already on its way.", 429, { retryAfterSeconds: Math.round(LOGIN_OTP_RESEND_MS / 1000) });
        }
        return { challenge: updated, code };
    }

    /**
     * Checks a code. On success the challenge is used up (so the code works
     * once) and returned; otherwise throws with what went wrong.
     */
    async verify(challengeId: string, rawCode: unknown): Promise<LoginChallenge> {
        const code = String(rawCode ?? "").replace(/\s+/g, "");
        if (!/^\d{6}$/.test(code)) {
            throw new LoginOtpError("CODE_WRONG", "Enter the 6-digit code from the email.", 400);
        }
        const open = await this.findOpen(challengeId);
        if (this.isExpired(open)) {
            throw new LoginOtpError("CODE_EXPIRED", "This code has expired. Ask for a new one.", 400);
        }

        // Count the try first, atomically, so parallel guesses can't exceed the limit
        const [counted] = await exec()
            .update(loginChallenges)
            .set({ attempts: sql`${loginChallenges.attempts} + 1` })
            .where(and(
                eq(loginChallenges.id, challengeId),
                isNull(loginChallenges.consumedAt),
                gt(loginChallenges.expiresAt, new Date()),
                lt(loginChallenges.attempts, LOGIN_OTP_MAX_ATTEMPTS),
            ))
            .returning();
        if (!counted) {
            throw new LoginOtpError("TOO_MANY_ATTEMPTS", "Too many wrong codes. Ask for a new code.", 429);
        }

        if (!sameHash(counted.codeHash, hashCode(challengeId, code))) {
            const left = LOGIN_OTP_MAX_ATTEMPTS - counted.attempts;
            throw left > 0
                ? new LoginOtpError("CODE_WRONG", `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`, 400, { attemptsLeft: left })
                : new LoginOtpError("TOO_MANY_ATTEMPTS", "Too many wrong codes. Ask for a new code.", 429);
        }

        // Use it up: only one request can do this
        const [used] = await exec()
            .update(loginChallenges)
            .set({ consumedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(loginChallenges.id, challengeId), isNull(loginChallenges.consumedAt)))
            .returning();
        if (!used) throw new LoginOtpError("CHALLENGE_INVALID", "This sign-in has already been used. Please sign in again.", 401);
        return used;
    }

    /** An unused challenge; expired ones still count as open for resending */
    private async findOpen(challengeId: string): Promise<LoginChallenge> {
        const invalid = () => new LoginOtpError("CHALLENGE_INVALID", "This sign-in has expired. Please sign in again.", 401);
        if (typeof challengeId !== "string" || !isUuid(challengeId)) throw invalid();
        const [challenge] = await exec().select().from(loginChallenges).where(eq(loginChallenges.id, challengeId)).limit(1);
        if (!challenge || challenge.consumedAt) throw invalid();
        // A sign-in can't be stretched out forever by resending
        if (Date.now() - new Date(challenge.createdAt).getTime() > 60 * 60 * 1000) throw invalid();
        return challenge;
    }

    /** Ends a challenge without signing in (e.g. its email couldn't be sent) */
    async close(challengeId: string): Promise<void> {
        if (!isUuid(challengeId)) return;
        await exec().update(loginChallenges).set({ consumedAt: new Date() }).where(and(eq(loginChallenges.id, challengeId), isNull(loginChallenges.consumedAt)));
    }

    /** Whether the code has run out (verify reports this as its own error) */
    isExpired(challenge: Pick<LoginChallenge, "expiresAt">) {
        return new Date(challenge.expiresAt).getTime() <= Date.now();
    }
}

/** "jo•••@gmail.com", so the screen can say where the code went without showing the whole address */
export function maskEmail(email: string): string {
    const [name, domain] = String(email).split("@");
    if (!domain) return email;
    const shown = name.length <= 2 ? name.slice(0, 1) : name.slice(0, 2);
    return `${shown}${"•".repeat(Math.max(3, Math.min(6, name.length - shown.length)))}@${domain}`;
}

export default new LoginOtpService();
