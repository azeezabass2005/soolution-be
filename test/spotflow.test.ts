import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/fincra.service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/services/fincra.service")>();
    return { ...actual, default: { ngnPerGhs: vi.fn(async () => 100) } };
});
vi.mock("../src/services/transaction-limit.service", () => ({
    default: {
        assertAllowed: vi.fn(async () => ({ ngnValue: 10_000 })),
        assertCanTransact: vi.fn(async () => undefined),
        check: vi.fn(async () => ({ allowed: true, ngnValue: 10_000 })),
        withUserLock: vi.fn(async (_userId: string, fn: () => Promise<unknown>) => fn()),
    },
}));
vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        sendTransactionNotification = vi.fn(async () => undefined);
        notifyAdmins = vi.fn(async () => undefined);
        sendNotification = vi.fn();
        emailService = { sendNotificationEmail: vi.fn() };
    },
}));

import crypto from "crypto";
import config from "../src/config/env.config";
import spotflowService from "../src/services/spotflow.service";
import TransactionService from "../src/services/transaction.service";
import transactionRepository from "../src/repositories/transaction.repository";
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { accountBalance, bootstrapLedger, createUser, walletBalance } from "./helpers/fixtures";
import reconciliationService from "../src/services/reconciliation.service";
import { SYSTEM_ACCOUNT_CODES, spotflowCashCode } from "../src/common/constant";

const WEBHOOK_SECRET = Buffer.from("spotflow-test-webhook-secret-123456").toString("base64");
const transactionService = new TransactionService();

/** Headers Spotflow would send for this body */
const signed = (body: string, { secret = WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000), id = `msg_${crypto.randomUUID()}` } = {}) => {
    const signature = crypto.createHmac("sha256", Buffer.from(secret, "base64")).update(`${id}.${at}.${body}`).digest("base64");
    return { "webhook-id": id, "webhook-timestamp": String(at), "x-spotflow-signature": `v1,${signature}` };
};

const credit = (accountId: string, amount: number, extra: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    account: { id: accountId, account_number: "1234567890", account_name: "Ama" },
    amount,
    currency: "GHS",
    type: "credit",
    status: "successful",
    source: "virtual_account",
    spotflow_reference: `SPF-${crypto.randomUUID()}`,
    ...extra,
});

describe("GHS by bank transfer (Spotflow one-time accounts)", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(async () => {
        vi.restoreAllMocks();
        Object.assign(config, {
            SPOTFLOW_GHS_ACCOUNTS_ENABLED: true,
            SPOTFLOW_SECRET_KEY: "sk_test_spotflow",
            SPOTFLOW_WEBHOOK_SECRET_KEY: `whsec_${WEBHOOK_SECRET}`,
        });
        await resetTestDatabase();
        await bootstrapLedger();
    });

    const open = async (amount = 100) => {
        const owner = await createUser();
        const accountId = crypto.randomUUID();
        vi.spyOn(spotflowService, "createDynamicAccount").mockResolvedValue({ id: accountId, accountNumber: "7706438396", accountName: "Grace Hopper", bankName: "Test Bank Ghana", mode: "test", lifeCycle: "temporary" });
        const transaction: any = await transactionService.createGhsAccountCollection({ amount }, owner.id);
        return { owner, accountId, transaction };
    };

    it("gives the payer an account for the exact amount and credits the NGN wallet once it's paid", async () => {
        const { owner, accountId, transaction } = await open(100);
        expect(transaction).toMatchObject({ status: "processing", payTo: { accountNumber: "7706438396", bankName: "Test Bank Ghana", accountName: "Grace Hopper" } });
        expect(spotflowService.createDynamicAccount).toHaveBeenCalledWith("GHS", expect.any(String), 100);

        // 100 GHS × ₦100 = ₦10,000; the default receive fee is 1.5%
        const result = await transactionService.handleSpotflowCredit(credit(accountId, 100));
        expect(result.outcome).toBe("credited");
        expect(await walletBalance(owner.id)).toBe(9_850);
        expect(await accountBalance(spotflowCashCode("GHS"))).toBe(10_000);
        expect(await accountBalance(SYSTEM_ACCOUNT_CODES.FEES_NGN)).toBe(150);
        expect((await transactionRepository.findById(transaction.id))?.status).toBe("completed");
        expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
    });

    it("credits once however many times the webhook arrives", async () => {
        const { owner, accountId } = await open(100);
        const event = credit(accountId, 100);
        await Promise.all([1, 2, 3, 4].map(() => transactionService.handleSpotflowCredit(event)));
        await transactionService.handleSpotflowCredit(event);
        expect(await walletBalance(owner.id)).toBe(9_850);
    });

    it("credits nothing for the wrong amount, currency or an unknown account", async () => {
        const { owner, accountId } = await open(100);
        expect((await transactionService.handleSpotflowCredit(credit(accountId, 60))).note).toBe("amount mismatch");
        expect((await transactionService.handleSpotflowCredit(credit(accountId, 100, { currency: "NGN" }))).note).toBe("amount mismatch");
        expect((await transactionService.handleSpotflowCredit(credit(crypto.randomUUID(), 100))).outcome).toBe("ignored");
        expect((await transactionService.handleSpotflowCredit(credit(accountId, 100, { status: "pending" }))).outcome).toBe("ignored");
        expect(await walletBalance(owner.id)).toBe(0);
    });

    it("closes unpaid accounts after they expire, and doesn't credit a transfer that arrives later", async () => {
        const { owner, accountId, transaction } = await open(100);
        await transactionRepository.update(transaction.id, { initiatedAt: new Date(Date.now() - 8 * 60 * 60 * 1000) });
        expect(await transactionService.expireGhsAccountCollections()).toBe(1);
        expect((await transactionRepository.findById(transaction.id))?.status).toBe("failed");
        expect((await transactionService.handleSpotflowCredit(credit(accountId, 100))).note).toBe("paid after close");
        expect(await walletBalance(owner.id)).toBe(0);
    });

    it("isn't offered until it's switched on", async () => {
        Object.assign(config, { SPOTFLOW_GHS_ACCOUNTS_ENABLED: false });
        const owner = await createUser();
        await expect(transactionService.createGhsAccountCollection({ amount: 100 }, owner.id)).rejects.toMatchObject({ response_code: 503 });
    });

    it("accepts only webhooks signed with the webhook secret, and only recent ones", () => {
        const body = JSON.stringify({ event: "account_credit_successful", data: { amount: 100 } });
        expect(spotflowService.verifyWebhook(body, signed(body))).toBe(true);
        expect(spotflowService.verifyWebhook(body.replace("100", "1000"), signed(body))).toBe(false);
        expect(spotflowService.verifyWebhook(body, signed(body, { secret: Buffer.from("someone-else").toString("base64") }))).toBe(false);
        expect(spotflowService.verifyWebhook(body, signed(body, { at: Math.floor(Date.now() / 1000) - 600 }))).toBe(false);
        expect(spotflowService.verifyWebhook(body, {})).toBe(false);
    });
});
