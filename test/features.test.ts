import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";

vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        emailService = { sendNotificationEmail: vi.fn(), sendWelcomeEmail: vi.fn(), verifyConnection: vi.fn(async () => true) };
        sendTransactionNotification = vi.fn();
        notifyAdmins = vi.fn();
        sendNotification = vi.fn();
        initializeWhatsApp = vi.fn();
    },
}));

import { startTestDatabase, stopTestDatabase } from "./helpers/db";
import { bootstrapLedger, createUser } from "./helpers/fixtures";
import App from "../src/app";
import TokenBuilder from "../src/utils/token.utils";
import { ROLE_MAP } from "../src/common/constant";
import userRepository from "../src/repositories/user.repository";
import platformSettingsService from "../src/services/platform-settings.service";

const tokenFor = (user: any) => new TokenBuilder().build().createToken(user, { expiresIn: "1h" } as any);

describe("beta features", () => {
    let server: Server;
    let base: string;
    const call = async (method: string, path: string, user: { id: string }, body?: unknown) => {
        const fresh = await userRepository.findById(user.id);
        const response = await fetch(`${base}/api/v1${path}`, {
            method,
            headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(fresh)}` },
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

    it("keeps a beta feature to beta users, turns an off feature off for everyone but admins", async () => {
        const boss = await createUser({ role: ROLE_MAP.ADMIN } as any);
        const user = await createUser();
        const tester = await createUser();

        // Everything is on to start with
        expect((await call("GET", "/protected/features", user)).body.data.features).toMatchObject({ payment_links: true, marketplace: true });

        expect((await call("PUT", "/protected/admin/platform-settings", boss, { operations: { features: { payment_links: "beta", marketplace: "off" } } })).status).toBe(200);
        platformSettingsService.clearCache();
        expect((await call("PUT", "/protected/admin/platform-settings", boss, { operations: { features: { nope: "on" } } })).status).toBe(400);
        expect((await call("PUT", `/protected/features/admin/users/${tester.id}`, user, { beta: true })).status).toBe(403);
        expect((await call("PUT", `/protected/features/admin/users/${tester.id}`, boss, { beta: true })).body.data).toMatchObject({ id: tester.id, beta: true });

        expect((await call("GET", "/protected/features", user)).body.data.features).toMatchObject({ payment_links: false, marketplace: false });
        expect((await call("GET", "/protected/features", tester)).body.data).toMatchObject({ beta: true, features: { payment_links: true, marketplace: false }, betaFeatures: ["payment_links"] });
        expect((await call("GET", "/protected/features", boss)).body.data.features).toMatchObject({ payment_links: true, marketplace: true });

        // The server refuses the route, not just the menu
        const refused = await call("POST", "/protected/payment-links", user, {});
        expect(refused.status).toBe(403);
        expect(refused.body.message).toContain("in beta");
        // A beta user gets past the guard (to validation)
        expect((await call("POST", "/protected/payment-links", tester, {})).status).not.toBe(403);

        const overview = (await call("GET", "/protected/features/admin", boss)).body.data;
        expect(overview.betaUsers.map((u: any) => u.id)).toEqual([tester.id]);
        expect(overview.features.find((f: any) => f.key === "payment_links").mode).toBe("beta");
    });
});
