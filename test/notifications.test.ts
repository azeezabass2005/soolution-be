import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";

vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        emailService = { sendNotificationEmail: vi.fn(async () => undefined), sendWelcomeEmail: vi.fn(), verifyConnection: vi.fn(async () => true) };
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
import inboxService from "../src/services/inbox.service";
import adminAccessService from "../src/services/admin-access.service";
import userRepository from "../src/repositories/user.repository";
import { exec } from "../src/repositories/utils";
import { transactions } from "../src/db/schema";

const tokenFor = (user: any) => new TokenBuilder().build().createToken(user, { expiresIn: "1h" } as any);

describe("in-app notifications", () => {
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

    it("keeps a user's own news, newest first, and pages back", async () => {
        const user = await createUser();
        for (let i = 1; i <= 3; i++) {
            await inboxService.toUser(user.id, { type: "transaction.completed", title: `✅ Payment ${i}`, body: `<strong>Done</strong> ${i}`, link: `https://app.example.test/dashboard/user/transactions?ref=${i}` });
            await new Promise((r) => setTimeout(r, 5));
        }
        const first = await inboxService.list(user.id, { limit: 2 });
        // Emoji and HTML gone, our own path kept
        expect(first.items[0]).toMatchObject({ title: "Payment 3", body: "Done 3", link: "/dashboard/user/transactions?ref=3", read: false });
        expect(first).toMatchObject({ hasMore: true, unread: 3 });
        const more = await inboxService.list(user.id, { limit: 2, before: first.items[1].id });
        expect(more.items.map((n) => n.title)).toEqual(["Payment 1"]);
        expect(more.hasMore).toBe(false);
    });

    it("clears one notification or all of them, only the person's own", async () => {
        const user = await createUser();
        const other = await createUser();
        for (let i = 0; i < 3; i++) await inboxService.toUser(user.id, { type: "transaction.completed", title: `Payment ${i}` });
        await inboxService.toUser(other.id, { type: "transaction.completed", title: "Someone else's" });
        const [first] = (await inboxService.list(user.id)).items;
        // Someone else's id does nothing
        await inboxService.clear(other.id, [first.id]);
        expect((await inboxService.list(user.id)).items).toHaveLength(3);
        const after = await inboxService.clear(user.id, [first.id]);
        expect(after.unread).toBe(2);
        expect((await inboxService.list(user.id)).items.map((n) => n.id)).not.toContain(first.id);
        await inboxService.clear(user.id, "all");
        expect((await inboxService.list(user.id)).items).toHaveLength(0);
        expect((await inboxService.list(other.id)).items).toHaveLength(1);
    });

    it("alerts the admins whose role covers it, and never someone else's inbox", async () => {
        const boss = await createUser({ role: ROLE_MAP.ADMIN } as any);
        const kycRole = await adminAccessService.createRole({ name: "KYC desk", permissions: ["kyc"] }, boss.id);
        const supportRole = await adminAccessService.createRole({ name: "Support only", permissions: ["support"] }, boss.id);
        const reviewer = await createUser({ role: ROLE_MAP.ADMIN, adminRoleId: kycRole.id } as any);
        const support = await createUser({ role: ROLE_MAP.ADMIN, adminRoleId: supportRole.id } as any);
        const customer = await createUser();

        await inboxService.toTeam("kyc", { type: "kyb.submitted", title: "New Business (KYB) submission", link: "/dashboard/admin/kyc/abc" });
        expect((await inboxService.list(boss.id)).items[0]).toMatchObject({ type: "kyb.submitted" });
        expect((await inboxService.list(reviewer.id)).items[0]).toMatchObject({ type: "kyb.submitted" });
        expect((await inboxService.list(support.id)).items).toHaveLength(0);
        expect((await inboxService.list(customer.id)).items).toHaveLength(0);
    });

    it("lists, counts and marks read over HTTP, and only your own", async () => {
        const user = await createUser();
        const other = await createUser();
        await inboxService.toUser(user.id, { type: "a", title: "One" });
        await inboxService.toUser(user.id, { type: "b", title: "Two" });
        await inboxService.toUser(other.id, { type: "c", title: "Theirs" });

        const list = await call("GET", "/protected/notifications", user);
        expect(list.body.data.items).toHaveLength(2);
        expect((await call("GET", "/protected/notifications/summary", user)).body.data).toEqual({ unread: 2, attention: {} });

        // Someone else's id does nothing
        const theirs = (await inboxService.list(other.id)).items[0].id;
        expect((await call("POST", "/protected/notifications/read", user, { ids: [theirs] })).body.data.unread).toBe(2);
        expect((await inboxService.list(other.id)).unread).toBe(1);

        expect((await call("POST", "/protected/notifications/read", user, { ids: [list.body.data.items[0].id] })).body.data.unread).toBe(1);
        expect((await call("POST", "/protected/notifications/read", user, { all: true })).body.data.unread).toBe(0);
    });

    it("tells admins what needs their attention, by role", async () => {
        const boss = await createUser({ role: ROLE_MAP.ADMIN } as any);
        const customer = await createUser();
        await exec().insert(transactions).values({ user: customer.id, reference: "WAIT-1", amount: 100, currency: "GHS", fromCurrency: "NGN", detailType: "bank_transfer" as any, status: "awaiting_confirmation" as any });
        expect((await call("GET", "/protected/notifications/summary", boss)).body.data.attention.pendingTransactions).toBeGreaterThanOrEqual(1);
        const role = await adminAccessService.createRole({ name: "Pricing only", permissions: ["pricing.daily_limits"] }, boss.id);
        const pricing = await createUser({ role: ROLE_MAP.ADMIN, adminRoleId: role.id } as any);
        expect((await call("GET", "/protected/notifications/summary", pricing)).body.data.attention).toEqual({});
    });
});
