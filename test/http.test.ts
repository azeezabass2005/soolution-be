import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";

/** The last sign-in code emailed, by address */
const sentCodes = vi.hoisted(() => new Map<string, string>());

vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        emailService = {
            sendNotificationEmail: vi.fn(async () => undefined),
            sendWelcomeEmail: vi.fn(async () => undefined),
            sendPasswordResetEmail: vi.fn(async () => undefined),
            sendLoginCodeEmail: vi.fn(async (to: string, data: { code: string }) => { sentCodes.set(to, data.code); }),
            verifyConnection: vi.fn(async () => true),
        };
        sendTransactionNotification = vi.fn();
        notifyAdmins = vi.fn();
        sendNotification = vi.fn();
        initializeWhatsApp = vi.fn();
    },
}));

import { startTestDatabase, stopTestDatabase } from "./helpers/db";
import { bootstrapLedger } from "./helpers/fixtures";
import App from "../src/app";

/**
 * End to end through Express: routing, auth middleware, controllers,
 * services, repositories and the error handler, on a real (in-memory) Postgres.
 */
describe("HTTP API", () => {
    let server: Server;
    let base: string;

    const call = async (method: string, path: string, body?: unknown, token?: string) => {
        const response = await fetch(`${base}/api/v1${path}`, {
            method,
            headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };

    beforeAll(async () => {
        await startTestDatabase();
        await bootstrapLedger();
        const app = new App();
        server = app.app.listen(0);
        await new Promise((resolve) => server.once("listening", resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        await stopTestDatabase();
    });

    it("reports the database in /health", async () => {
        const response = await fetch(`${base}/health`);
        expect(response.status).toBe(200);
        expect((await response.json()).database).toBe(true);
    });

    let accessToken: string;
    let userId: string;

    it("registers, completes sign-up and signs in", async () => {
        const registered = await call("POST", "/public/auth/register", {
            email: "grace@example.test",
            password: "correct-horse-battery",
            firstName: "Grace",
            lastName: "Hopper",
        });
        expect(registered.status).toBe(201);
        userId = registered.body.data.userId;
        expect(userId).toMatch(/^[0-9a-f-]{36}$/);

        const duplicate = await call("POST", "/public/auth/register", {
            email: "GRACE@example.test", password: "correct-horse-battery", firstName: "Grace", lastName: "Hopper",
        });
        expect(duplicate.status).toBe(409);

        const completed = await call("PATCH", "/public/auth/complete-registration", {
            registrationToken: registered.body.data.registrationToken,
            phoneNumber: "+2348012345678",
            countryOfResidence: "Nigeria",
            purpose: "personal",
            hearAboutUs: "friends",
        });
        expect(completed.status).toBe(200);
        expect(completed.body.data.user.id).toBe(userId);

        // The password alone doesn't sign in: it sends a code to the email
        const login = await call("POST", "/public/auth/login", { email: "grace@example.test", password: "correct-horse-battery" });
        expect(login.status).toBe(200);
        expect(login.body.data).toMatchObject({ otpRequired: true, email: "gr•••@example.test" });
        expect(login.body.data.accessToken).toBeUndefined();
        const challengeId = login.body.data.challengeId;
        const code = sentCodes.get("grace@example.test")!;
        expect(code).toMatch(/^\d{6}$/);

        const wrongCode = await call("POST", "/public/auth/login/verify", { challengeId, code: code === "000000" ? "111111" : "000000" });
        expect(wrongCode.status).toBe(400);
        expect(wrongCode.body.details).toMatchObject({ code: "CODE_WRONG", attemptsLeft: 4 });

        const verified = await call("POST", "/public/auth/login/verify", { challengeId, code });
        expect(verified.status).toBe(200);
        accessToken = verified.body.data.accessToken;
        expect(accessToken).toBeTruthy();

        // A code works once
        const again = await call("POST", "/public/auth/login/verify", { challengeId, code });
        expect(again.status).toBe(401);

        const wrong = await call("POST", "/public/auth/login", { email: "grace@example.test", password: "wrong-password!" });
        expect(wrong.status).toBe(401);
    });

    it("locks a code after 5 wrong tries, and only the newest sign-in's code works", async () => {
        const first = await call("POST", "/public/auth/login", { email: "grace@example.test", password: "correct-horse-battery" });
        const firstCode = sentCodes.get("grace@example.test")!;
        const second = await call("POST", "/public/auth/login", { email: "grace@example.test", password: "correct-horse-battery" });
        const code = sentCodes.get("grace@example.test")!;
        expect((await call("POST", "/public/auth/login/verify", { challengeId: first.body.data.challengeId, code: firstCode })).status).toBe(401);

        const challengeId = second.body.data.challengeId;
        const wrong = code === "123456" ? "654321" : "123456";
        for (let i = 0; i < 5; i++) await call("POST", "/public/auth/login/verify", { challengeId, code: wrong });
        const locked = await call("POST", "/public/auth/login/verify", { challengeId, code });
        expect(locked.status).toBe(429);
        expect(locked.body.details.code).toBe("TOO_MANY_ATTEMPTS");

        // A new code can't be asked for straight away
        const tooSoon = await call("POST", "/public/auth/login/resend", { challengeId });
        expect(tooSoon.status).toBe(429);
        expect(tooSoon.body.details.code).toBe("RESEND_TOO_SOON");

        expect((await call("POST", "/public/auth/login/verify", { challengeId: "not-a-uuid", code: "123456" })).status).toBe(401);
        expect((await call("POST", "/public/auth/login/verify", { challengeId, code: "12ab" })).status).toBe(400);
    });

    it("works when the browser sends an old shared-domain cookie alongside the current one", async () => {
        const login = await call("POST", "/public/auth/login", { email: "grace@example.test", password: "correct-horse-battery" });
        const response = await fetch(`${base}/api/v1/public/auth/login/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ challengeId: login.body.data.challengeId, code: sentCodes.get("grace@example.test") }),
        });
        expect(response.status).toBe(200);
        const setCookies = response.headers.getSetCookie();
        const value = (name: string) => setCookies.find((c) => c.startsWith(`${name}=`) && !/Domain=\.example\.test/i.test(c))!.split(";")[0].split("=").slice(1).join("=");
        // The old shared-domain cookies are cleared with the new session
        expect(setCookies.some((c) => c.startsWith("accessToken=;") && /Domain=\.example\.test/i.test(c))).toBe(true);

        // A token from another environment (different secret) sent first must not get in the way
        const foreign = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXBlIjoiYWNjZXNzIn0.c2lnbmVkLWVsc2V3aGVyZQ";
        const me = await fetch(`${base}/api/v1/protected/users/current`, { headers: { cookie: `accessToken=${foreign}; accessToken=${value("accessToken")}` } });
        expect(me.status).toBe(200);

        const refreshed = await fetch(`${base}/api/v1/public/auth/refresh-token`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: `refreshToken=${foreign}; refreshToken=${value("refreshToken")}` },
            body: "{}",
        });
        expect(refreshed.status).toBe(200);
        expect((await refreshed.json()).data.accessToken).toBeTruthy();
    });

    it("returns the current user without secrets, with id and _id", async () => {
        const me = await call("GET", "/protected/users/current", undefined, accessToken);
        expect(me.status).toBe(200);
        const user = me.body.data.user;
        expect(user.id).toBe(userId);
        expect(user._id).toBe(userId);
        expect(user.email).toBe("grace@example.test");
        expect(user.role).toBe("USER");
        expect(user.identity).toEqual({ status: "unverified" });
        expect(user.password).toBeUndefined();
        expect(user.transactionPinHash).toBeUndefined();
        expect(user.phoneNumber).toBe("+2348012345678");
    });

    it("opened an NGN wallet at sign-up", async () => {
        const balance = await call("GET", "/protected/wallet/balance", undefined, accessToken);
        expect(balance.status).toBe(200);
        expect(balance.body.data).toMatchObject({ balance: 0, currency: "NGN", status: "active" });
    });

    it("lists transactions in the paginator shape the frontend reads", async () => {
        const list = await call("GET", "/protected/transactions/bank-transfer?page=1&limit=5&status=all", undefined, accessToken);
        expect(list.status).toBe(200);
        expect(list.body.data).toEqual({
            data: [],
            paginator: { itemsCount: 0, perPage: 5, pageCount: 1, currentPage: 1, serialNumber: 1, hasPrevPage: false, hasNextPage: false, prev: null, next: null },
        });
    });

    it("keeps admin routes and other users' data closed", async () => {
        expect((await call("GET", "/protected/dashboard", undefined, accessToken)).status).toBe(403);
        expect((await call("GET", "/protected/users/current")).status).toBe(401);
        // A malformed id is just "not found", never a database error
        const receipt = await call("POST", "/protected/transactions/not-a-uuid/receipt-token", {}, accessToken);
        expect(receipt.status).toBe(404);
    });

    it("signs out everywhere", async () => {
        // Tokens issued over a second before sign-out stop working (1s clock tolerance)
        await new Promise((resolve) => setTimeout(resolve, 2100));
        const out = await call("POST", "/public/auth/logout-all", {}, accessToken);
        expect(out.status).toBe(200);
        expect((await call("GET", "/protected/users/current", undefined, accessToken)).status).toBe(401);
    });
});
