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
import TokenBuilder from "../src/utils/token.utils";
import { exec } from "../src/repositories/utils";
import { transactions } from "../src/db/schema";
import App from "../src/app";

/** An admin opening one user's page sees only that user's transactions */
describe("admin transaction lists filtered by user", () => {
    let server: Server;
    let base: string;
    let token: string;
    let ann: string;
    let ben: string;

    const tx = (user: string, currency: string) => exec().insert(transactions).values({
        user, reference: `T-${Math.random().toString(36).slice(2)}`, amount: 100, currency, fromCurrency: "NGN",
        detailType: "bank" as any, status: "completed" as any,
    });
    const list = async (path: string) => {
        const r = await fetch(`${base}/api/v1/protected/transactions/${path}`, { headers: { authorization: `Bearer ${token}` } });
        const body: any = await r.json();
        return { status: r.status, rows: (body?.data?.data ?? []) as any[] };
    };

    beforeAll(async () => {
        await startTestDatabase();
        await bootstrapLedger();
        const admin = await createUser({ role: 7832 } as any);
        token = new TokenBuilder().build().createToken(admin as any);
        ann = (await createUser()).id;
        ben = (await createUser()).id;
        await tx(ann, "NGN");
        await tx(ann, "RMB");
        await tx(ben, "KES");
        await tx(ben, "RMB");
        await tx(ben, "RMB");
        const app = new App();
        server = app.app.listen(0);
        await new Promise((resolve) => server.once("listening", resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        await stopTestDatabase();
    });

    it("lists only the chosen user's bank and alipay transactions", async () => {
        expect((await list(`bank-transfer-admin?user=${ann}`)).rows.map((t) => t.currency)).toEqual(["NGN"]);
        expect((await list(`alipay-admin?user=${ann}`)).rows).toHaveLength(1);
        expect((await list(`bank-transfer-admin?user=${ben}`)).rows.map((t) => t.currency)).toEqual(["KES"]);
        expect((await list(`alipay-admin?user=${ben}`)).rows).toHaveLength(2);
    });

    it("still lists everyone's without a user, and refuses a malformed one", async () => {
        expect((await list("alipay-admin")).rows).toHaveLength(3);
        expect((await list("bank-transfer-admin?user=abc")).status).toBe(400);
    });
});
