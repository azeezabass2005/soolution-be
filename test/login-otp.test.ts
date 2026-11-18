import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { getDb } from "../src/db/client";
import { loginChallenges } from "../src/db/schema";
import loginOtpService, { LOGIN_OTP_MAX_PER_HOUR, LOGIN_OTP_MAX_SENDS, LoginOtpError, maskEmail } from "../src/services/login-otp.service";

const meta = { rememberMe: true, ipAddress: "127.0.0.1", userAgent: "test" };
const backdate = (id: string, patch: Partial<typeof loginChallenges.$inferInsert>) =>
    getDb().update(loginChallenges).set(patch).where(eq(loginChallenges.id, id));
const errorCode = async (p: Promise<unknown>) => {
    try {
        await p;
        return "OK";
    } catch (e) {
        return e instanceof LoginOtpError ? e.code : String(e);
    }
};

describe("sign-in codes", () => {
    let userId: string;
    beforeAll(async () => { await startTestDatabase(); });
    afterAll(async () => { await stopTestDatabase(); });
    beforeEach(async () => {
        await resetTestDatabase();
        userId = (await createUser()).id;
    });

    it("stores only a hash, and remembers the sign-in choice", async () => {
        const { challenge, code } = await loginOtpService.start(userId, meta);
        expect(challenge.codeHash).not.toContain(code);
        const used = await loginOtpService.verify(challenge.id, ` ${code.slice(0, 3)} ${code.slice(3)} `);
        expect(used.rememberMe).toBe(true);
    });

    it("refuses an expired code", async () => {
        const { challenge, code } = await loginOtpService.start(userId, meta);
        await backdate(challenge.id, { expiresAt: new Date(Date.now() - 1000) });
        expect(await errorCode(loginOtpService.verify(challenge.id, code))).toBe("CODE_EXPIRED");
    });

    it("resends after a minute with a new code, and the old one stops working", async () => {
        const { challenge, code: oldCode } = await loginOtpService.start(userId, meta);
        await loginOtpService.verify(challenge.id, oldCode === "000000" ? "111111" : "000000").catch(() => undefined);
        await backdate(challenge.id, { lastSentAt: new Date(Date.now() - 61_000), expiresAt: new Date(Date.now() - 1000) });

        const { code } = await loginOtpService.resend(challenge.id);
        const [row] = await getDb().select().from(loginChallenges).where(eq(loginChallenges.id, challenge.id));
        expect(row.attempts).toBe(0);
        expect(row.sendCount).toBe(2);
        if (code !== oldCode) expect(await errorCode(loginOtpService.verify(challenge.id, oldCode))).toBe("CODE_WRONG");
        expect(await errorCode(loginOtpService.verify(challenge.id, code))).toBe("OK");
    });

    it("caps resends per sign-in and sign-ins per hour", async () => {
        const { challenge } = await loginOtpService.start(userId, meta);
        await backdate(challenge.id, { sendCount: LOGIN_OTP_MAX_SENDS, lastSentAt: new Date(Date.now() - 61_000) });
        expect(await errorCode(loginOtpService.resend(challenge.id))).toBe("TOO_MANY_CODES");

        for (let i = 1; i < LOGIN_OTP_MAX_PER_HOUR; i++) await loginOtpService.start(userId, meta);
        expect(await errorCode(loginOtpService.start(userId, meta))).toBe("TOO_MANY_CODES");
    });

    it("accepts a code only once, even when two requests race", async () => {
        const { challenge, code } = await loginOtpService.start(userId, meta);
        const results = await Promise.all([errorCode(loginOtpService.verify(challenge.id, code)), errorCode(loginOtpService.verify(challenge.id, code))]);
        expect(results.filter((r) => r === "OK")).toHaveLength(1);
    });

    it("masks the email it shows", () => {
        expect(maskEmail("joseph@gmail.com")).toBe("jo••••@gmail.com");
        expect(maskEmail("a@b.co")).toBe("a•••@b.co");
    });
});
