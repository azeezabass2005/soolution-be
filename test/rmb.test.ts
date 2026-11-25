import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => [] as Array<{ title: string; message: string }>);
vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        emailService = { sendNotificationEmail: vi.fn(), verifyConnection: vi.fn(async () => true) };
        sendTransactionNotification = vi.fn();
        notifyAdmins = vi.fn();
        initializeWhatsApp = vi.fn();
        sendNotification = vi.fn(async (_user: any, cfg: any) => { notices.push({ title: cfg.title, message: cfg.message }); return { email: true, whatsapp: false }; });
    },
}));

import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { TEST_PIN, bootstrapLedger, createUser, fundWallet, walletBalance } from "./helpers/fixtures";
import TransactionService from "../src/services/transaction.service";
import platformSettingsService from "../src/services/platform-settings.service";
import transactionDetailRepository from "../src/repositories/transaction-detail.repository";

const ADMIN = "00000000-0000-4000-8000-000000000001";

describe("RMB sends", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(async () => {
        await resetTestDatabase();
        await bootstrapLedger();
        platformSettingsService.clearCache();
        notices.length = 0;
        // Manual payments open every day, all day, at ₦220 per yuan
        await platformSettingsService.updateSettings({ operations: { manual: { rates: { RMB: 220 }, days: [0, 1, 2, 3, 4, 5, 6], open: "00:00", close: "23:59", closedDates: [] } } }, ADMIN);
    });

    const send = (userId: string, amount: number) => new TransactionService().createAlipayTransaction(
        { amount, fromCurrency: "NGN", paymentMethod: "alipay", platform: "alipay", alipayNo: "13800138000", alipayName: "Li Wei", pin: TEST_PIN } as any,
        { qrCodeUrl: "https://example.test/qr.png" },
        userId,
    );

    it("takes the naira from the NGN wallet at the manual rate, with no transfer to us, and goes straight to our team", async () => {
        const user = await createUser();
        await fundWallet(user.id, 100_000);
        const tx: any = await send(user.id, 200);

        // ¥200 × ₦220 = ₦44,000 taken from the wallet; nothing to transfer or upload
        expect(await walletBalance(user.id)).toBe(56_000);
        expect(tx.status).toBe("awaiting_confirmation");
        const details = await transactionDetailRepository.findByTransactionId(tx.id ?? tx._id);
        expect(details).toMatchObject({ fundingCurrency: "NGN", fundingAmount: 44_000 });
        expect(Object.keys((details as any).bankAccountDetails ?? {})).toHaveLength(0);
        expect(notices.at(-1)).toMatchObject({ title: "Your RMB payment is on its way" });
        expect(notices.at(-1)!.message).toContain("taken from your NGN wallet");
    });

    it("refuses when the NGN wallet doesn't cover it, and refunds the wallet when ops rejects it", async () => {
        const poor = await createUser();
        await fundWallet(poor.id, 10_000);
        await expect(send(poor.id, 200)).rejects.toBeTruthy();
        expect(await walletBalance(poor.id)).toBe(10_000);

        const user = await createUser();
        await fundWallet(user.id, 100_000);
        const tx: any = await send(user.id, 100);
        expect(await walletBalance(user.id)).toBe(78_000);
        await new TransactionService().rejectManualTransaction(tx.id ?? tx._id, "Recipient's Alipay is closed", ADMIN);
        expect(await walletBalance(user.id)).toBe(100_000);
    });
});
