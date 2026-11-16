import crypto from "crypto";
import userRepository from "../../src/repositories/user.repository";
import { bootstrapSystemAccounts } from "../../src/services/account.bootstrap";
import WalletService from "../../src/services/wallet.service";
import accountRepository from "../../src/repositories/account.repository";
import walletRepository from "../../src/repositories/wallet.repository";
import { withTransaction } from "../../src/db/transaction";
import ledgerService from "../../src/services/ledger.service";
import HashService from "../../src/utils/hash.utils";
import { JOURNAL_DIRECTION, JOURNAL_SOURCE, SYSTEM_ACCOUNT_CODES, userWalletAccountCode } from "../../src/common/constant";
import type { User } from "../../src/types/entities";
import type { WalletCurrency } from "../../src/common/wallet.constants";

export const TEST_PIN = "1234";

let pinHash: string | undefined;

/** A verified (Tier 1) user with a transaction PIN and an NGN wallet */
export async function createUser(overrides: Partial<Parameters<typeof userRepository.create>[0]> = {}): Promise<User> {
    pinHash ??= (await HashService.hashPassword(TEST_PIN)).password;
    const user = await userRepository.create({
        email: `user-${crypto.randomUUID()}@example.test`,
        password: "hashed",
        firstName: "Ada",
        lastName: "Lovelace",
        tier: 1,
        identityStatus: "verified",
        isCompleted: true,
        transactionPinHash: pinHash,
        isTransactionPinSet: true,
        ...overrides,
    });
    await new WalletService().getOrCreateWallet(user.id);
    return user;
}

export async function bootstrapLedger(): Promise<void> {
    await bootstrapSystemAccounts();
}

/**
 * Put money in a user's wallet the way funding does: a balanced posting from
 * Paystack cash plus the wallet's cached balance, in one transaction.
 */
export async function fundWallet(userId: string, amount: number, currency: WalletCurrency = "NGN"): Promise<void> {
    const wallet = await new WalletService().getOrCreateWallet(userId, currency);
    // Non-NGN wallets are filled by exchange; for tests, fund them from the FX position
    const source = currency === "NGN" ? SYSTEM_ACCOUNT_CODES.CASH_PAYSTACK_NGN : `FX_POSITION_${currency}`;
    await withTransaction(async (tx) => {
        await ledgerService.post({
            legs: [
                { accountCode: source, direction: JOURNAL_DIRECTION.DEBIT, amount },
                { accountCode: userWalletAccountCode(userId, currency), direction: JOURNAL_DIRECTION.CREDIT, amount },
            ],
            source: JOURNAL_SOURCE.FUNDING,
            reference: `TEST-FUND-${crypto.randomUUID()}`,
            description: "Test funding",
            perCurrency: currency !== "NGN",
            tx,
        });
        await walletRepository.credit(wallet.id, amount, tx, { alsoLedger: true });
    });
}

export async function walletBalance(userId: string, currency = "NGN"): Promise<number> {
    return (await walletRepository.findByUserAndCurrency(userId, currency))?.balance ?? 0;
}

export async function accountBalance(code: string): Promise<number> {
    return (await accountRepository.findByCode(code))?.balance ?? 0;
}
