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

vi.mock("../src/services/yellowcard.service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/services/yellowcard.service")>();
    const market = (currency: string) => ({ currency, country: "KE" });
    return {
        ...actual,
        default: {
            ...(actual as any).default,
            getCountryConfig: vi.fn(async (_c: string, currency: string) => ({ currency, send: true, receive: true, channelTypes: ["momo"] })),
            flowCurrencies: vi.fn(async () => ({ send: ["KES", "ZAR"], receive: ["KES", "ZAR"], markets: { send: [market("KES"), market("ZAR")], receive: [market("KES"), market("ZAR")] }, unavailable: {} })),
        },
    };
});

import { startTestDatabase, stopTestDatabase } from "./helpers/db";
import { bootstrapLedger, createUser } from "./helpers/fixtures";
import App from "../src/app";
import TokenBuilder from "../src/utils/token.utils";
import { ROLE_MAP } from "../src/common/constant";
import userRepository from "../src/repositories/user.repository";
import platformSettingsService from "../src/services/platform-settings.service";
import { FEATURES } from "../src/common/features";
import { exec } from "../src/repositories/utils";
import { paymentLinks } from "../src/db/schema";

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

    const gated = async (method: string, path: string, user: { id: string }) => {
        const r = await call(method, path, user, {});
        return r.status === 403 && /is in beta and not open to your account yet|isn't available right now\./.test(r.body.message);
    };
    const setModes = async (boss: { id: string }, features: Record<string, string>) => {
        expect((await call("PUT", "/protected/admin/platform-settings", boss, { operations: { features } })).status).toBe(200);
        platformSettingsService.clearCache();
    };
    const publicView = async (slug: string) => (await (await fetch(`${base}/api/v1/public/pay/${slug}`)).json()).data.link;
    const publicPay = async (slug: string) => {
        const r = await fetch(`${base}/api/v1/public/pay/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        return { status: r.status, body: await r.json() };
    };

    it("keeps each feature separate: one switch never opens or closes another", async () => {
        const boss = await createUser({ role: ROLE_MAP.ADMIN } as any);
        const user = await createUser();
        await setModes(boss, { payment_links: "on", african_sends: "on", african_receives: "on", wallet_exchange: "on", marketplace: "on" });

        // Sends off: the send list drops African currencies, the receive list keeps them; sends are refused, exchange isn't
        await setModes(boss, { african_sends: "off" });
        const lists = (await call("GET", "/protected/yellowcard/currencies", user)).body.data;
        expect(lists.send).toEqual([]);
        expect(lists.receive).toEqual(["KES", "ZAR"]);
        expect(lists.markets.send).toEqual([]);
        expect(await gated("POST", "/protected/yellowcard", user)).toBe(true);
        expect(await gated("POST", "/protected/yellowcard/collect", user)).toBe(false);
        expect(await gated("POST", "/protected/wallet/exchange/quote", user)).toBe(false);
        expect((await call("GET", "/protected/features", user)).body.data.features).toEqual({ payment_links: true, african_sends: false, african_receives: true, wallet_exchange: true, marketplace: true });

        // Receives off: the reverse
        await setModes(boss, { african_sends: "on", african_receives: "off" });
        const lists2 = (await call("GET", "/protected/yellowcard/currencies", user)).body.data;
        expect([lists2.send, lists2.receive]).toEqual([["KES", "ZAR"], []]);
        expect(await gated("POST", "/protected/yellowcard/collect", user)).toBe(true);
        expect(await gated("POST", "/protected/yellowcard", user)).toBe(false);

        // Exchange off: quotes and exchanges refused, nothing else
        await setModes(boss, { african_receives: "on", wallet_exchange: "off" });
        expect(await gated("POST", "/protected/wallet/exchange/quote", user)).toBe(true);
        expect(await gated("POST", "/protected/wallet/exchange", user)).toBe(true);
        expect(await gated("POST", "/protected/yellowcard", user)).toBe(false);
        expect(await gated("POST", "/protected/payment-links", user)).toBe(false);
        // Reads keep working, so history still shows
        expect((await call("GET", "/protected/payment-links", user)).status).toBe(200);
    });

    it("stops a user's existing payment links when payment links, or receiving their currency, is closed to them", async () => {
        const boss = await createUser({ role: ROLE_MAP.ADMIN } as any);
        const owner = await createUser();
        await setModes(boss, { payment_links: "on", african_receives: "on", wallet_exchange: "on" });
        const [ghs] = await exec().insert(paymentLinks).values({ user: owner.id, slug: "ghsLink001", currency: "GHS" } as any).returning();
        const [kes] = await exec().insert(paymentLinks).values({ user: owner.id, slug: "kesLink001", currency: "KES" } as any).returning();
        expect((await publicView(ghs.slug)).available).toBe(true);
        expect((await publicView(kes.slug)).available).toBe(true);

        // Receiving African currencies off: the KES link stops, the GHS one doesn't
        await setModes(boss, { african_receives: "off" });
        expect((await publicView(kes.slug)).available).toBe(false);
        expect((await publicPay(kes.slug)).status).toBe(409);
        expect((await publicView(ghs.slug)).available).toBe(true);
        // Nor can a new KES link be made, or the KES link be turned back on
        expect((await call("PATCH", `/protected/payment-links/${kes.id}`, owner, { active: false })).status).toBe(200);
        expect((await call("PATCH", `/protected/payment-links/${kes.id}`, owner, { active: true })).status).toBe(403);

        // Payment links kept to beta: the owner's links stop until they're a beta user
        await setModes(boss, { african_receives: "on", payment_links: "beta" });
        expect((await publicView(ghs.slug)).available).toBe(false);
        expect((await publicPay(ghs.slug)).status).toBe(409);
        await call("PUT", `/protected/features/admin/users/${owner.id}`, boss, { beta: true });
        expect((await publicView(ghs.slug)).available).toBe(true);
        expect((await call("PATCH", `/protected/payment-links/${kes.id}`, owner, { active: true })).status).toBe(200);
        // Taken off beta again: closed again
        await call("PUT", `/protected/features/admin/users/${owner.id}`, boss, { beta: false });
        expect((await publicView(ghs.slug)).available).toBe(false);
    });

    it("keeps other wallets and exchange closed until an admin opens wallet exchange", async () => {
        const boss = await createUser({ role: ROLE_MAP.ADMIN } as any);
        const user = await createUser();
        // Never set: off (production keeps other wallets closed until an admin opens them)
        expect(FEATURES.find((f) => f.key === "wallet_exchange")?.defaultMode).toBe("off");
        await setModes(boss, { wallet_exchange: "off" });
        expect((await call("GET", "/protected/features", user)).body.data.features.wallet_exchange).toBe(false);
        expect((await call("POST", "/protected/wallet/create", user, { currency: "KES" })).status).toBe(403);

        // Beta: only beta users open a KES wallet
        await setModes(boss, { wallet_exchange: "beta" });
        expect((await call("POST", "/protected/wallet/create", user, { currency: "KES" })).status).toBe(403);
        await call("PUT", `/protected/features/admin/users/${user.id}`, boss, { beta: true });
        expect((await call("POST", "/protected/wallet/create", user, { currency: "KES" })).status).toBe(201);
    });
});
