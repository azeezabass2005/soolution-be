import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";

vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        emailService = {
            sendNotificationEmail: vi.fn(async () => undefined),
            sendWelcomeEmail: vi.fn(async () => undefined),
            sendPasswordResetEmail: vi.fn(async () => undefined),
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

        const login = await call("POST", "/public/auth/login", { email: "grace@example.test", password: "correct-horse-battery" });
        expect(login.status).toBe(200);
        accessToken = login.body.data.accessToken;
        expect(accessToken).toBeTruthy();

        const wrong = await call("POST", "/public/auth/login", { email: "grace@example.test", password: "wrong-password!" });
        expect(wrong.status).toBe(401);
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
