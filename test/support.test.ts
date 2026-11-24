import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";

const sentToUsers = vi.hoisted(() => [] as Array<{ to: string; title: string }>);

vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        emailService = { sendNotificationEmail: vi.fn(async () => undefined), sendWelcomeEmail: vi.fn(), verifyConnection: vi.fn(async () => true) };
        sendTransactionNotification = vi.fn();
        notifyAdmins = vi.fn();
        sendNotification = vi.fn(async (user: any, cfg: any) => { sentToUsers.push({ to: user.email, title: cfg.title }); return { email: true, whatsapp: false }; });
        initializeWhatsApp = vi.fn();
    },
}));

import { startTestDatabase, stopTestDatabase } from "./helpers/db";
import { bootstrapLedger, createUser } from "./helpers/fixtures";
import App from "../src/app";
import TokenBuilder from "../src/utils/token.utils";
import { ROLE_MAP } from "../src/common/constant";
import adminAccessService from "../src/services/admin-access.service";
import inboxService from "../src/services/inbox.service";
import userRepository from "../src/repositories/user.repository";
import { exec } from "../src/repositories/utils";
import { transactions } from "../src/db/schema";

const tokenFor = (user: any) => new TokenBuilder().build().createToken(user, { expiresIn: "1h" } as any);

describe("support and disputes", () => {
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

    it("runs a support conversation between a user and the support team", async () => {
        const boss = await createUser({ role: ROLE_MAP.ADMIN } as any);
        const role = await adminAccessService.createRole({ name: "Support desk", permissions: ["support"] }, boss.id);
        const agent = await createUser({ role: ROLE_MAP.ADMIN, adminRoleId: role.id } as any);
        const user = await createUser({ email: "help.me@example.test" });

        const opened = await call("POST", "/protected/support", user, { subject: "Can't add money", body: "My transfer hasn't shown up." });
        expect(opened.status).toBe(201);
        const id = opened.body.data.id;
        expect(opened.body.data).toMatchObject({ kind: "support", status: "open", messages: [{ fromTeam: false, body: "My transfer hasn't shown up." }] });
        // The support team hears about it, and it counts as waiting
        expect((await inboxService.list(agent.id)).items[0]).toMatchObject({ type: "support.message", link: `/dashboard/admin/support?ticket=${id}` });
        expect((await call("GET", "/protected/notifications/summary", agent)).body.data.attention).toMatchObject({ openTickets: 1 });

        const replied = await call("POST", `/protected/admin/support/${id}/messages`, agent, { body: "We've found it, it lands in 10 minutes." });
        expect(replied.body.data).toMatchObject({ status: "answered", assignedTo: agent.id });
        expect(sentToUsers.at(-1)).toMatchObject({ to: "help.me@example.test", title: "New reply: Can't add money" });
        // The user sees the team's reply, not who wrote it
        const mine = (await call("GET", `/protected/support/${id}`, user)).body.data;
        expect(mine.messages.map((m: any) => m.fromTeam)).toEqual([false, true]);
        expect(mine.messages[1].author).toBeUndefined();

        // Another user can't read or reply
        const stranger = await createUser();
        expect((await call("GET", `/protected/support/${id}`, stranger)).status).toBe(404);
        expect((await call("POST", `/protected/support/${id}/messages`, stranger, { body: "hi" })).status).toBe(404);

        expect((await call("POST", `/protected/support/${id}/messages`, user, { body: "Thanks, got it" })).body.data.status).toBe("open");
        expect((await call("PATCH", `/protected/admin/support/${id}`, agent, { status: "resolved" })).body.data.status).toBe("resolved");
        expect((await call("POST", `/protected/support/${id}/messages`, user, { body: "One more thing" })).status).toBe(409);
    });

    it("keeps disputes to the disputes team, one open per transaction, with an outcome the user sees", async () => {
        const boss = await createUser({ role: ROLE_MAP.ADMIN } as any);
        const supportOnly = await adminAccessService.createRole({ name: "Support only 2", permissions: ["support"] }, boss.id);
        const agent = await createUser({ role: ROLE_MAP.ADMIN, adminRoleId: supportOnly.id } as any);
        const user = await createUser();
        const [tx] = await exec().insert(transactions).values({ user: user.id, reference: "DISP-1", amount: 100, currency: "KES", fromCurrency: "NGN", detailType: "yellowcard" as any, status: "completed" as any }).returning();
        const someoneElses = await createUser();
        const [otherTx] = await exec().insert(transactions).values({ user: someoneElses.id, reference: "DISP-2", amount: 100, currency: "KES", fromCurrency: "NGN", detailType: "yellowcard" as any, status: "completed" as any }).returning();

        expect((await call("POST", "/protected/support", user, { kind: "dispute", subject: "Recipient didn't get it", body: "Wanjiru says nothing arrived." })).status).toBe(400);
        expect((await call("POST", "/protected/support", user, { kind: "dispute", subject: "Not mine", body: "Someone else's transaction", transactionId: otherTx.id })).status).toBe(404);
        const opened = await call("POST", "/protected/support", user, { kind: "dispute", subject: "Recipient didn't get it", body: "Wanjiru says nothing arrived.", transactionId: tx.id });
        expect(opened.status).toBe(201);
        expect((await call("POST", "/protected/support", user, { kind: "dispute", subject: "Again", body: "Still nothing arrived", transactionId: tx.id })).status).toBe(409);

        const id = opened.body.data.id;
        // A support-only agent can't see disputes
        expect((await call("GET", `/protected/admin/support/${id}`, agent)).status).toBe(404);
        expect((await call("GET", "/protected/admin/support?kind=dispute", agent)).body.data).toEqual([]);

        const detail = (await call("GET", `/protected/admin/support/${id}`, boss)).body.data;
        expect(detail).toMatchObject({ kind: "dispute", transaction: { reference: "DISP-1" }, statuses: ["open", "investigating", "resolved", "rejected"] });
        expect((await call("PATCH", `/protected/admin/support/${id}`, boss, { status: "resolved" })).status).toBe(400);
        const closed = await call("PATCH", `/protected/admin/support/${id}`, boss, { status: "resolved", resolution: "YellowCard confirmed the payout; the recipient's network was delayed." });
        expect(closed.body.data).toMatchObject({ status: "resolved", resolution: expect.stringContaining("YellowCard confirmed") });
        expect(sentToUsers.at(-1)?.title).toBe("Your dispute was resolved: Recipient didn't get it");
    });
});
