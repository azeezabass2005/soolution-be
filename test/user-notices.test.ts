import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";

// Email and WhatsApp are mocked; the in-app inbox is real
const sent = vi.hoisted(() => [] as Array<{ to: string; type: string; title: string; message: string }>);
vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        emailService = { sendNotificationEmail: vi.fn(async () => undefined), sendWelcomeEmail: vi.fn(), verifyConnection: vi.fn(async () => true) };
        sendTransactionNotification = vi.fn();
        notifyAdmins = vi.fn();
        initializeWhatsApp = vi.fn();
        sendNotification = vi.fn(async (user: any, cfg: any) => {
            sent.push({ to: user.email, type: cfg.type, title: cfg.title, message: cfg.message });
            const { default: inbox } = await import("../src/services/inbox.service");
            await inbox.toUser(user.id, { type: cfg.type, title: cfg.title, body: cfg.message, link: cfg.actionUrl, data: cfg.data });
            return { email: true, whatsapp: false };
        });
    },
}));

import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { bootstrapLedger, createUser } from "./helpers/fixtures";
import App from "../src/app";
import TokenBuilder from "../src/utils/token.utils";
import userRepository from "../src/repositories/user.repository";
import userNoticesService from "../src/services/user-notices.service";
import { exec } from "../src/repositories/utils";
import { transactionDetails, transactions, walletTransactions, wallets } from "../src/db/schema";
import { eq } from "drizzle-orm";

const tokenFor = (user: any) => new TokenBuilder().build().createToken(user, { expiresIn: "1h" } as any);
const run = () => userNoticesService.run({ graceSeconds: 0 });

describe("user notices and the inbox", () => {
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
        const app = new App();
        server = app.app.listen(0);
        await new Promise((resolve) => server.once("listening", resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        await stopTestDatabase();
    });
    beforeEach(async () => {
        await resetTestDatabase();
        await bootstrapLedger();
        sent.length = 0;
    });

    const send = async (userId: string, reference: string, status: string, extra: Record<string, unknown> = {}) => {
        const [t] = await exec().insert(transactions).values({ user: userId, reference, amount: 200, currency: "KES", fromCurrency: "NGN", detailType: "yellowcard" as any, status: "processing" as any }).returning();
        await exec().insert(transactionDetails).values({ transactionId: t.id, type: "yellowcard" as any, fromAmount: 30_000, accountName: "Wanjiru Kamau" } as any);
        await exec().update(transactions).set({ status: status as any, ...extra }).where(eq(transactions.id, t.id));
        return t;
    };

    it("tells the user once how each send and receive ended, and nothing for a receive the payer abandoned", async () => {
        const user = await createUser({ email: "ada.notices@example.test" });
        await send(user.id, "SEND-OK", "completed", { completedAt: new Date() });
        await send(user.id, "SEND-BAD", "failed", { failedAt: new Date(), cancelReason: "The recipient's account is closed" });
        await send(user.id, "SEND-CANCEL", "cancelled");
        const [receive] = await exec().insert(transactions).values({ user: user.id, reference: "RECV-OK", amount: 5000, currency: "NGN", fromCurrency: "KES", detailType: "yellowcard" as any, status: "completed" as any, payerName: "Otieno" }).returning();
        await exec().insert(transactionDetails).values({ transactionId: receive.id, type: "yellowcard" as any, fromAmount: 57_000 } as any);
        await exec().insert(transactions).values({ user: user.id, reference: "RECV-GONE", amount: 5000, currency: "NGN", fromCurrency: "KES", detailType: "yellowcard" as any, status: "cancelled" as any });

        expect(await run()).toBe(4);
        expect(sent.map((s) => [s.type, s.title])).toEqual(expect.arrayContaining([
            ["transaction.completed", "Money sent"],
            ["transaction.failed", "Your transfer didn't go through"],
            ["transaction.cancelled", "Your transfer was cancelled"],
            ["transaction.received", "Payment received"],
        ]));
        expect(sent.find((s) => s.type === "transaction.completed")!.message).toContain("KES 200.00 to Wanjiru Kamau has been paid");
        expect(sent.find((s) => s.type === "transaction.failed")!.message).toContain("Reason: The recipient's account is closed.");
        expect(sent.find((s) => s.type === "transaction.received")!.message).toContain("KES 5,000.00 from Otieno. NGN 57,000.00 has been added");
        // Never twice
        expect(await run()).toBe(0);
    });

    it("tells deposits and withdrawals once, a failed-then-reversed withdrawal once, and skips what a path already told", async () => {
        const user = await createUser();
        const [wallet] = await exec().select().from(wallets).where(eq(wallets.user, user.id));
        const wtx = (reference: string, type: string, status: string, extra: Record<string, unknown> = {}) =>
            exec().insert(walletTransactions).values({ wallet: wallet.id, user: user.id, type: type as any, status: status as any, amount: 10_000, currency: "NGN", reference, balanceBefore: 0, balanceAfter: 10_000, ...extra }).returning();
        await wtx("FUND-1", "funding", "successful");
        const [withdrawal] = await wtx("WDR-1", "withdrawal", "failed", { failureReason: "Rejected: account name doesn't match", recipientAccountName: "Ada Lovelace", recipientBankName: "GTBank" });
        await wtx("EXCH-1", "exchange", "successful");

        expect(await run()).toBe(2);
        expect(sent.map((s) => s.type).sort()).toEqual(["wallet.funded", "withdrawal.failed"]);
        expect(sent.find((s) => s.type === "withdrawal.failed")!.message).toContain("to Ada Lovelace (GTBank) couldn't be paid. Reason: Rejected: account name doesn't match.");

        await exec().update(walletTransactions).set({ status: "reversed" as any }).where(eq(walletTransactions.id, withdrawal.id));
        expect(await run()).toBe(0);

        // A path that told the user itself (the manual payout with its receipt) isn't repeated
        const told = await send(user.id, "MANUAL-1", "completed", { completedAt: new Date() });
        await userNoticesService.markTold("transaction", told.id, "completed");
        expect(await run()).toBe(0);
    });

    it("lists notifications with read state, and marks one or all read", async () => {
        const user = await createUser();
        await send(user.id, "A-1", "completed", { completedAt: new Date() });
        await send(user.id, "A-2", "failed", { failedAt: new Date() });
        await send(user.id, "A-3", "cancelled");
        await run();

        const list = (await call("GET", "/protected/notifications", user)).body.data;
        expect(list.unread).toBe(3);
        expect(list.items.every((n: any) => n.read === false && n.link === "/dashboard/user/transactions" && n.data?.transactionId)).toBe(true);
        expect((await call("GET", "/protected/notifications/summary", user)).body.data.unread).toBe(3);

        expect((await call("POST", "/protected/notifications/read", user, { ids: [list.items[0].id] })).body.data.unread).toBe(2);
        const after = (await call("GET", "/protected/notifications", user)).body.data.items;
        expect(after.find((n: any) => n.id === list.items[0].id).read).toBe(true);
        expect(after.filter((n: any) => !n.read)).toHaveLength(2);

        // Someone else can't mark them
        const other = await createUser();
        await call("POST", "/protected/notifications/read", other, { all: true });
        expect((await call("GET", "/protected/notifications/summary", user)).body.data.unread).toBe(2);

        expect((await call("POST", "/protected/notifications/read", user, { all: true })).body.data.unread).toBe(0);
        expect((await call("GET", "/protected/notifications", user)).body.data.items.every((n: any) => n.read)).toBe(true);
    });
});
