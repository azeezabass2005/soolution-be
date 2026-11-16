import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 1 GHS = ₦100 at Fincra; YellowCard is never needed for NGN or GHS
vi.mock("../src/services/fincra.service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/services/fincra.service")>();
    return { ...actual, default: { ngnPerGhs: vi.fn(async () => 100) } };
});
vi.mock("../src/services/yellowcard.service", () => ({
    default: { getRates: vi.fn(async () => { throw new Error("YellowCard is not configured"); }) },
}));

import transactionLimitService from "../src/services/transaction-limit.service";
import transactionRepository from "../src/repositories/transaction.repository";
import platformSettingsService from "../src/services/platform-settings.service";
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { bootstrapLedger, createUser } from "./helpers/fixtures";

const record = (userId: string, ngnValue: number, status = "processing") =>
    transactionRepository.create({
        user: userId,
        reference: `SP_TEST_${Math.random().toString(36).slice(2)}`,
        amount: ngnValue,
        currency: "NGN",
        fromCurrency: "NGN",
        detailType: "fincra",
        status,
        ngnValue,
        initiatedAt: new Date(),
    } as any);

describe("daily tier limits (NGN)", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(async () => {
        await resetTestDatabase();
        await bootstrapLedger();
    });

    it("gives Tier 1 ₦5,000,000 a day", async () => {
        const user = await createUser();
        const status = await transactionLimitService.getStatus(user.id);
        expect(status).toMatchObject({ tier: 1, limitNgn: 5_000_000, usedNgn: 0, remainingNgn: 5_000_000 });
        expect(status.nextTier).toMatchObject({ tier: 2, limitNgn: 150_000_000 });
    });

    it("allows up to the limit and refuses past it, with the amounts in naira", async () => {
        const user = await createUser();
        await record(user.id, 4_000_000);
        await record(user.id, 900_000, "failed"); // released: doesn't count

        await expect(transactionLimitService.assertAllowed(user.id, [{ amount: 1_000_000, currency: "NGN" }])).resolves.toEqual({ ngnValue: 1_000_000 });
        const refusal = transactionLimitService.assertAllowed(user.id, [{ amount: 1_000_001, currency: "NGN" }]);
        await expect(refusal).rejects.toMatchObject({ response_code: 403 });
        await expect(refusal).rejects.toMatchObject({ message: expect.stringContaining("₦5,000,000") });
    });

    it("values GHS at Fincra's rate without YellowCard", async () => {
        const user = await createUser();
        const check = await transactionLimitService.check(user.id, [{ amount: 500, currency: "GHS" }]);
        expect(check).toMatchObject({ allowed: true, ngnValue: 50_000 });
        // The NGN side is used when a transaction has one
        const both = await transactionLimitService.check(user.id, [{ amount: 500, currency: "GHS" }, { amount: 51_000, currency: "NGN" }]);
        expect(both.ngnValue).toBe(51_000);
    });

    it("follows the limit an admin sets", async () => {
        const user = await createUser();
        await platformSettingsService.updateSettings({ tierDailyLimitNgn: { tier1: 1_000_000 } } as any, user.id);
        expect((await transactionLimitService.getStatus(user.id)).limitNgn).toBe(1_000_000);
    });

    it("keeps unverified accounts out", async () => {
        const user = await createUser({ tier: 0, identityStatus: "unverified" } as any);
        const check = await transactionLimitService.check(user.id, [{ amount: 1000, currency: "NGN" }]);
        expect(check).toMatchObject({ allowed: false, reason: "identity_required" });
    });
});
