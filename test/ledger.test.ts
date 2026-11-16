import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { accountBalance, bootstrapLedger, createUser, fundWallet, walletBalance } from "./helpers/fixtures";
import ledgerService from "../src/services/ledger.service";
import { withTransaction } from "../src/db/transaction";
import accountRepository from "../src/repositories/account.repository";
import journalRepository from "../src/repositories/journal.repository";
import reconciliationService from "../src/services/reconciliation.service";
import { JOURNAL_DIRECTION, JOURNAL_SOURCE, SYSTEM_ACCOUNT_CODES, userWalletAccountCode } from "../src/common/constant";
import { getDb } from "../src/db/client";
import { accounts } from "../src/db/schema";
import { eq } from "drizzle-orm";

const { CASH_PAYSTACK_NGN, SUSPENSE_NGN, FEES_NGN } = SYSTEM_ACCOUNT_CODES;
import { fincraCashCode } from "../src/common/constant";

describe("LedgerService", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(async () => {
        await resetTestDatabase();
        await bootstrapLedger();
    });

    it("bootstraps the system accounts idempotently", async () => {
        const first = (await accountRepository.listAll()).length;
        const again = await (await import("../src/services/account.bootstrap")).bootstrapSystemAccounts();
        expect(first).toBeGreaterThan(20);
        expect(again.created).toBe(0);
        expect(again.existing).toBe(first);
    });

    it("posts a balanced entry and moves cached balances by account type", async () => {
        const result = await withTransaction((tx) =>
            ledgerService.post({
                legs: [
                    { accountCode: CASH_PAYSTACK_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: 1000 },
                    { accountCode: SUSPENSE_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: 1000 },
                ],
                source: JOURNAL_SOURCE.FUNDING,
                reference: "REF-1",
                description: "test",
                externalRef: { provider: "paystack", id: "ps-1" },
                tx,
            })
        );

        expect(result.entries).toHaveLength(2);
        expect(result.entries[0].externalRef).toEqual({ provider: "paystack", id: "ps-1" });
        // Asset debited → up; liability credited → up
        expect(await accountBalance(CASH_PAYSTACK_NGN)).toBe(1000);
        expect(await accountBalance(SUSPENSE_NGN)).toBe(1000);
        expect(await ledgerService.computeBalance(CASH_PAYSTACK_NGN)).toBe(1000);
        expect(await ledgerService.getTxGroup(result.txGroupId)).toHaveLength(2);
    });

    it("refuses an unbalanced posting and writes nothing", async () => {
        await expect(
            withTransaction((tx) =>
                ledgerService.post({
                    legs: [
                        { accountCode: CASH_PAYSTACK_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: 100 },
                        { accountCode: SUSPENSE_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: 90 },
                    ],
                    source: JOURNAL_SOURCE.FUNDING,
                    reference: "BAD",
                    description: "unbalanced",
                    tx,
                })
            )
        ).rejects.toMatchObject({ message: expect.stringContaining("Unbalanced") });
        expect(await accountBalance(CASH_PAYSTACK_NGN)).toBe(0);
        expect((await journalRepository.paginate({}, {})).paginator.itemsCount).toBe(0);
    });

    it("refuses postings to an unknown or frozen account", async () => {
        const post = (code: string) =>
            withTransaction((tx) =>
                ledgerService.post({
                    legs: [
                        { accountCode: CASH_PAYSTACK_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: 5 },
                        { accountCode: code, direction: JOURNAL_DIRECTION.CREDIT, amount: 5 },
                    ],
                    source: JOURNAL_SOURCE.FUNDING,
                    reference: "X",
                    description: "x",
                    tx,
                })
            );
        await expect(post("NOPE")).rejects.toMatchObject({ message: expect.stringContaining("not found") });

        await getDb().update(accounts).set({ status: "frozen" }).where(eq(accounts.code, FEES_NGN));
        await expect(post(FEES_NGN)).rejects.toMatchObject({ response_code: 400 });
    });

    it("rolls back the journal when the surrounding transaction fails", async () => {
        await expect(
            withTransaction(async (tx) => {
                await ledgerService.post({
                    legs: [
                        { accountCode: CASH_PAYSTACK_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: 50 },
                        { accountCode: SUSPENSE_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: 50 },
                    ],
                    source: JOURNAL_SOURCE.FUNDING,
                    reference: "ROLLBACK",
                    description: "x",
                    tx,
                });
                throw new Error("boom");
            })
        ).rejects.toThrow("boom");
        expect(await accountBalance(CASH_PAYSTACK_NGN)).toBe(0);
        expect((await journalRepository.paginate({}, {})).data).toHaveLength(0);
    });

    it("keeps exact decimals (no float drift) across many small postings", async () => {
        for (let i = 0; i < 10; i++) {
            await ledgerService.postStandalone({
                legs: [
                    { accountCode: CASH_PAYSTACK_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: 0.1 },
                    { accountCode: SUSPENSE_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: 0.1 },
                ],
                source: JOURNAL_SOURCE.FUNDING,
                reference: `DEC-${i}`,
                description: "dime",
            });
        }
        // 10 × 0.1 in JS floats is 0.9999999999999999; numeric keeps it exact
        expect(await accountBalance(CASH_PAYSTACK_NGN)).toBe(1);
    });

    it("paginates the journal in the API's paginator shape", async () => {
        for (let i = 0; i < 3; i++) {
            await ledgerService.postStandalone({
                legs: [
                    { accountCode: CASH_PAYSTACK_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: 1 },
                    { accountCode: SUSPENSE_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: 1 },
                ],
                source: JOURNAL_SOURCE.FUNDING,
                reference: `P-${i}`,
                description: "p",
            });
        }
        const page = await ledgerService.listEntries({ accountCode: SUSPENSE_NGN }, { page: 2, limit: 2 });
        expect(page.data).toHaveLength(1);
        expect(page.paginator).toEqual({
            itemsCount: 3,
            perPage: 2,
            pageCount: 2,
            currentPage: 2,
            serialNumber: 3,
            hasPrevPage: true,
            hasNextPage: false,
            prev: 1,
            next: null,
        });
    });

    it("attributes a suspense credit to a user exactly once", async () => {
        const user = await createUser();
        await ledgerService.postStandalone({
            legs: [
                { accountCode: CASH_PAYSTACK_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: 2500 },
                { accountCode: SUSPENSE_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: 2500 },
            ],
            source: JOURNAL_SOURCE.FUNDING,
            reference: "UNMATCHED",
            description: "held",
        });
        const [open] = (await ledgerService.listOpenSuspense({})).data;

        const result = await ledgerService.attributeSuspense({ journalEntryId: open.id, userId: user.id, note: "matched" });
        expect(result.amount).toBe(2500);
        expect(await walletBalance(user.id)).toBe(2500);
        expect(await accountBalance(SUSPENSE_NGN)).toBe(0);
        expect(await accountBalance(userWalletAccountCode(user.id, "NGN"))).toBe(2500);
        expect((await ledgerService.listOpenSuspense({})).data).toHaveLength(0);

        await expect(ledgerService.attributeSuspense({ journalEntryId: open.id, userId: user.id })).rejects.toMatchObject({
            message: expect.stringContaining("already been attributed"),
        });
        expect(await walletBalance(user.id)).toBe(2500);
    });

    it("reconciliation is clean after real postings and flags drift", async () => {
        const user = await createUser();
        await fundWallet(user.id, 1000);

        const clean = await reconciliationService.runFullReconciliation({ runMode: "cron" });
        expect(clean.status).toBe("clean");
        expect(clean.walletProof.walletsChecked).toBe(1);
        expect(clean.ledgerProof.unbalancedGroups).toHaveLength(0);

        // Tamper with a cached balance
        await accountRepository.setBalance(fincraCashCode("NGN"), 999);
        const drift = await reconciliationService.runFullReconciliation({ runMode: "cron" });
        expect(drift.status).toBe("mismatch");
        expect(drift.accountProof.mismatches).toEqual([{ code: fincraCashCode("NGN"), expected: 1000, actual: 999, delta: -1 }]);
        const alerts = await reconciliationService.listAlerts({ acknowledged: false }, {});
        expect(alerts.data.some((alert) => alert.code === "account_balance_drift")).toBe(true);

        // refreshAccountBalance repairs it from the journal
        expect(await ledgerService.refreshAccountBalance(fincraCashCode("NGN"))).toBe(1000);
        expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
    });
});
