import type { Executor } from "../db/client";
import { lockKey, withTransaction } from "../db/transaction";
import { isUniqueViolation } from "../db/errors";
import walletRepository from "../repositories/wallet.repository";
import walletTransactionRepository from "../repositories/wallet-transaction.repository";
import accountRepository from "../repositories/account.repository";
import type { Wallet, WalletTransaction } from "../types/entities";
import WalletTransactionService from "./wallet-transaction.service";
import fincraService, { FincraError } from "./fincra.service";
import userRepository from "../repositories/user.repository";
import { decryptIdentity } from "../utils/identity-crypto.utils";
import { IDENTITY_STATUS, IDENTITY_REQUIRED_CODE } from "../common/identity.constants";
import journalRepository from "../repositories/journal.repository";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import {
    WALLET_STATUS,
    WALLET_TRANSACTION_TYPE,
    WALLET_TRANSACTION_STATUS,
    ACCOUNT_TYPE,
    JOURNAL_DIRECTION,
    JOURNAL_SOURCE,
    SYSTEM_ACCOUNT_CODES,
    WEBHOOK_PROVIDER,
    userWalletAccountCode,
    fincraCashCode,
    fincraPayoutInflightCode,
} from "../common/constant";
import { WALLET_LIMITS } from "../config/wallet-limits.config";
import { BASE_WALLET_CURRENCY, OPENABLE_WALLET_CURRENCIES, WALLETS_UNAVAILABLE_CODE, WALLET_CURRENCIES, WalletCurrency, isWalletCurrency } from "../common/wallet.constants";
import logger from "../utils/logger.utils";
import config from "../config/env.config";
import PinService from "./pin.service";
import ledgerService from "./ledger.service";
import platformSettingsService from "./platform-settings.service";
import AuditLogService from "./audit-log.service";
import { withoutProviderName } from "../utils/provider-names.utils";
import type { PageRequest } from "../db/pagination";

const auditLogService = new AuditLogService();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Who the NGN virtual account is for */
interface DvaOwner {
    id: string;
}

const FINCRA = WEBHOOK_PROVIDER.FINCRA;
const NGN_CASH = fincraCashCode("NGN");
const NGN_PAYOUT_INFLIGHT = fincraPayoutInflightCode("NGN");

/** Fincra's deposit webhook (collection.successful) data, as far as we read it */
export interface FincraDeposit {
    reference?: string;
    virtualAccount?: string;
    sourceAmount?: number | string;
    amountReceived?: number | string;
    fee?: number | string;
    destinationCurrency?: string;
    status?: string;
    senderAccountName?: string;
    senderBankName?: string;
    [key: string]: unknown;
}

/** "Ada Lovelace-Byron" → { firstName: "Ada", lastName: "Lovelace-Byron" } */
const splitName = (full: string) => {
    const parts = (full || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { firstName: "Account", lastName: "Holder" };
    if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
    return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
};

/** A Fincra error that means the request certainly didn't create a payout */
const definitelyRejected = (error: unknown) =>
    error instanceof FincraError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;


/**
 * Journal legs for a withdrawal of `amount` with `fee` on top. "initiate"
 * moves the money from the user to in-flight and the fee to revenue;
 * "reverse" puts both back.
 */
function withdrawalLegs(userAccountCode: string, amount: number, fee: number, kind: "initiate" | "reverse") {
    const out = kind === "initiate" ? JOURNAL_DIRECTION.DEBIT : JOURNAL_DIRECTION.CREDIT;
    const back = kind === "initiate" ? JOURNAL_DIRECTION.CREDIT : JOURNAL_DIRECTION.DEBIT;
    const legs = [
        { accountCode: userAccountCode, direction: out, amount: Math.round((amount + fee) * 100) / 100 },
        { accountCode: NGN_PAYOUT_INFLIGHT, direction: back, amount },
    ];
    if (fee > 0) legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: back, amount: fee });
    return legs;
}

/** A withdrawal in one of these has settled one way or the other and must not move again */
const WITHDRAWAL_SETTLED = [
    WALLET_TRANSACTION_STATUS.SUCCESSFUL as "successful",
    WALLET_TRANSACTION_STATUS.FAILED as "failed",
    WALLET_TRANSACTION_STATUS.REVERSED as "reversed",
];

class WalletService {
    private walletTransactionService: WalletTransactionService;
    private pinService: PinService;

    constructor() {
        this.walletTransactionService = new WalletTransactionService();
        this.pinService = new PinService();
    }

    // ===================== WALLET MANAGEMENT =====================

    /**
     * Get or create one of a user's wallets (NGN unless another currency is
     * given). Also ensures the wallet's ledger account
     * (USER_WALLET_{CUR}:{userId}) exists so postings have a target ready.
     */
    async getOrCreateWallet(userId: string, currency: WalletCurrency = BASE_WALLET_CURRENCY, tx?: Executor): Promise<Wallet> {
        const { wallet } = await walletRepository.findOrCreate(userId, currency, tx);
        await this.ensureUserLedgerAccount(userId, wallet, tx);
        return wallet;
    }

    /** One of the user's wallets, if it exists */
    async findWallet(userId: string, currency: string, tx?: Executor): Promise<Wallet | undefined> {
        return walletRepository.findByUserAndCurrency(userId, currency, tx);
    }

    /** The user's NGN wallet if it exists (funding, withdrawals and NGN sends use it) */
    async findBaseWallet(userId: string, tx?: Executor): Promise<Wallet | undefined> {
        return walletRepository.findByUserAndCurrency(userId, BASE_WALLET_CURRENCY, tx);
    }

    async findById(walletId: string): Promise<Wallet | undefined> {
        return walletRepository.findById(walletId);
    }

    /** All of a user's wallets, NGN first then in the order they were opened */
    async listWallets(userId: string) {
        await this.getOrCreateWallet(userId);
        const wallets = await walletRepository.listByUser(userId);
        return wallets
            .map((w) => ({
                id: w.id,
                currency: w.currency,
                balance: w.balance,
                ledgerBalance: w.ledgerBalance,
                status: w.status,
                isDVAProvisioned: w.isDVAProvisioned,
                dvaBankName: w.dvaBankName,
                dvaAccountNumber: w.dvaAccountNumber,
                dvaAccountName: w.dvaAccountName,
                createdAt: w.createdAt,
            }))
            .sort((a, b) => Number(b.currency === BASE_WALLET_CURRENCY) - Number(a.currency === BASE_WALLET_CURRENCY));
    }

    /** Open a wallet in another currency */
    async createWallet(userId: string, currency: unknown): Promise<Wallet> {
        const code = typeof currency === "string" ? currency.trim().toUpperCase() : currency;
        if (!isWalletCurrency(code)) {
            throw errorResponseMessage.createError(400, "Choose a currency we support for wallets", ErrorSeverity.LOW, {
                supported: WALLET_CURRENCIES,
            });
        }
        if (code !== BASE_WALLET_CURRENCY && !OPENABLE_WALLET_CURRENCIES.includes(code)) {
            throw errorResponseMessage.createError(403, "Other wallets aren't available yet.", ErrorSeverity.LOW, { code: WALLETS_UNAVAILABLE_CODE });
        }
        const existing = await walletRepository.findByUserAndCurrency(userId, code);
        if (existing) {
            throw errorResponseMessage.createError(409, `You already have a ${code} wallet`, ErrorSeverity.LOW, {
                walletId: existing.id,
            });
        }
        const wallet = await this.getOrCreateWallet(userId, code);
        logger.info("Wallet opened", { userId, currency: code });
        return wallet;
    }

    /**
     * Idempotently create the user's per-currency ledger liability account.
     * Called from getOrCreateWallet so any path that touches a wallet has the
     * matching ledger account in place.
     */
    private async ensureUserLedgerAccount(userId: string, wallet: Wallet, tx?: Executor): Promise<void> {
        await accountRepository.createIfMissing(
            {
                code: userWalletAccountCode(userId, wallet.currency),
                type: ACCOUNT_TYPE.LIABILITY,
                currency: wallet.currency,
                name: `User wallet ${wallet.currency} — ${userId}`,
                ownerUser: userId,
                ownerWallet: wallet.id,
                balance: 0,
                isSystem: false,
            },
            tx
        );
    }

    /**
     * Give the user's NGN wallet its own Fincra virtual account (lazy, on first
     * access). Fincra checks the BVN against the name, so the user must have
     * verified their identity. The request is keyed by the wallet, so asking
     * twice can't open two accounts; an account Fincra is still reviewing is
     * re-checked instead.
     */
    async provisionDVA(walletId: string, owner: DvaOwner): Promise<Wallet> {
        const wallet = await walletRepository.findById(walletId);
        if (!wallet) throw errorResponseMessage.resourceNotFound("Wallet");
        if (wallet.isDVAProvisioned) return wallet;

        // Requested before: see whether Fincra has approved it
        if (wallet.dvaProvider === FINCRA && wallet.dvaExternalId) {
            if (wallet.dvaStatus === "declined") {
                throw errorResponseMessage.createError(409, "We couldn't open your account number. Please contact support.", ErrorSeverity.MEDIUM, { code: "DVA_DECLINED" });
            }
            const account = await fincraService.getVirtualAccount(wallet.dvaExternalId);
            return (await this.applyVirtualAccount(wallet, account)) ?? wallet;
        }

        const user = await userRepository.findById(owner.id, { withSecrets: true });
        if (!user) throw errorResponseMessage.resourceNotFound("User");
        const bvnEnc = user.identity?.bvnEnc;
        if (user.identity?.status !== IDENTITY_STATUS.VERIFIED || !bvnEnc) {
            throw errorResponseMessage.createError(403, "Verify your identity to get your account number.", ErrorSeverity.LOW, { code: IDENTITY_REQUIRED_CODE });
        }

        const request = {
            firstName: user.firstName || "",
            lastName: user.lastName || "",
            email: user.email,
            bvn: decryptIdentity(bvnEnc),
            merchantReference: `sp-va-${wallet.id}`,
        };
        // Moniepoint (FINCRA_VA_CHANNEL) by default. If Fincra refuses that bank,
        // the user still gets an account number, at Fincra's default bank.
        const channel = config.FINCRA_VA_CHANNEL || undefined;
        let account: any;
        try {
            account = await fincraService.createVirtualAccount({ ...request, channel });
        } catch (error) {
            const refused = error instanceof FincraError && error.status >= 400 && error.status < 500 && error.status !== 409 && error.status !== 429;
            if (!channel || !refused) throw error;
            logger.warn("Fincra refused the preferred bank for a virtual account; using Fincra's default bank", { walletId, channel, error: (error as Error).message });
            account = await fincraService.createVirtualAccount(request);
        }
        const externalId = String(account?._id || account?.id || "");
        if (!externalId) throw errorResponseMessage.createError(500, "Our payment provider didn't return an account. Please try again.", ErrorSeverity.HIGH);
        const pending = await walletRepository.update(wallet.id, { dvaProvider: FINCRA, dvaExternalId: externalId, dvaStatus: String(account?.status || "pending") });
        logger.info("Fincra virtual account requested", { walletId, externalId, status: account?.status });
        return (await this.applyVirtualAccount(pending ?? wallet, account)) ?? pending ?? wallet;
    }

    /**
     * Record what Fincra says about a wallet's virtual account (from a fetch or
     * the virtualaccount.* webhooks). The account is usable once it has a number.
     */
    private async applyVirtualAccount(wallet: Wallet, account: any): Promise<Wallet | undefined> {
        const status = String(account?.status || wallet.dvaStatus || "pending").toLowerCase();
        const info = account?.accountInformation || {};
        const accountNumber = info.accountNumber || account?.accountNumber;
        if (accountNumber && status !== "declined" && status !== "closed") {
            const updated = await walletRepository.update(wallet.id, {
                dvaStatus: status,
                dvaBankName: info.bankName || account?.bankName,
                dvaAccountNumber: String(accountNumber),
                dvaAccountName: info.accountName || account?.accountName || account?.KYCInformation?.firstName && `${account.KYCInformation.firstName} ${account.KYCInformation.lastName || ""}`.trim(),
                isDVAProvisioned: true,
            });
            logger.info("Wallet virtual account ready", { walletId: wallet.id, accountNumber });
            return updated;
        }
        if (status !== wallet.dvaStatus) return walletRepository.update(wallet.id, { dvaStatus: status, ...(status === "closed" ? { isDVAProvisioned: false } : {}) });
        return wallet;
    }

    /** Fincra's virtualaccount.* webhook: approved, issued, declined, closed */
    async handleVirtualAccountEvent(account: any): Promise<boolean> {
        const externalId = String(account?.id || account?._id || "");
        if (!externalId) return false;
        const wallet = await walletRepository.findByDvaExternalId(FINCRA, externalId);
        if (!wallet) {
            logger.warn("Fincra virtual account event for an unknown account", { externalId, status: account?.status });
            return false;
        }
        const incoming = String(account?.status || "").toLowerCase();
        if ((wallet.dvaStatus === "closed" || wallet.dvaStatus === "declined") && incoming !== "closed" && incoming !== "declined") {
            // A late or retried event from before the account was shut
            logger.warn("Fincra virtual account event after it was closed/declined; ignored", { walletId: wallet.id, externalId, incoming, current: wallet.dvaStatus });
            return true;
        }
        await this.applyVirtualAccount(wallet, account);
        return true;
    }

    // ===================== PIN MANAGEMENT =====================
    // The PIN lives on the user and is managed by PinService. These keep the
    // wallet-scoped API that wallet.controller.ts uses.

    async setPin(userId: string, pin: string): Promise<void> {
        await this.pinService.setPin(userId, pin);
    }

    async changePin(userId: string, oldPin: string, newPin: string): Promise<void> {
        await this.pinService.changePin(userId, oldPin, newPin);
    }

    async verifyPin(userId: string, pin: string): Promise<void> {
        await this.pinService.verifyPin(userId, pin);
    }

    // ===================== FUNDING (Webhook-driven) =====================

    /**
     * A deposit into a user's Fincra virtual account (collection.successful).
     * The wallet gets what Fincra settled (amountReceived, after its fee), so
     * the books always match Fincra. Idempotent on Fincra's reference: a unique
     * index on funding rows means a repeated (or concurrent) webhook can never
     * credit twice. Money for an unknown or inactive wallet is held in SUSPENSE.
     */
    async processFunding(deposit: FincraDeposit): Promise<WalletTransaction | null> {
        const reference = String(deposit.reference || "");
        const amount = Math.round(Number(deposit.amountReceived ?? deposit.sourceAmount) * 100) / 100;
        const virtualAccountId = deposit.virtualAccount ? String(deposit.virtualAccount) : undefined;
        if (!reference || !(amount > 0)) {
            logger.warn("Fincra deposit without a reference or amount; ignored", { reference, amount: deposit.amountReceived });
            return null;
        }
        if (deposit.destinationCurrency && String(deposit.destinationCurrency).toUpperCase() !== "NGN") {
            logger.warn("Fincra deposit in a currency other than NGN; ignored", { reference, currency: deposit.destinationCurrency });
            return null;
        }

        const existing = await walletTransactionRepository.findByPaystackReference(reference);
        if (existing) {
            logger.info("Wallet funding already processed (idempotent)", { reference });
            return null;
        }

        const details = {
            virtualAccountId,
            fee: deposit.fee,
            sourceAmount: deposit.sourceAmount,
            sender: deposit.senderAccountName,
            senderBank: deposit.senderBankName,
        };
        logger.info("Processing funding", { reference, virtualAccountId, amount });

        const wallet = virtualAccountId ? await walletRepository.findByDvaExternalId(FINCRA, virtualAccountId) : undefined;
        if (!wallet) {
            logger.error("Wallet not found for funding — routing to SUSPENSE", { reference, virtualAccountId });
            await this.recordSuspenseFunding({ reference, amount, details });
            return null;
        }
        if (wallet.status !== WALLET_STATUS.ACTIVE) {
            logger.warn("Funding attempted on non-active wallet — routing to SUSPENSE", { walletId: wallet.id, status: wallet.status });
            await this.recordSuspenseFunding({ reference, amount, details, note: `wallet status is ${wallet.status}` });
            return null;
        }

        await this.ensureUserLedgerAccount(wallet.user, wallet);
        const target = wallet;

        // The user pays the admin's total funding fee (e.g. 1% capped at ₦500) on what
        // they sent. Fincra already kept its part; SolutionPay takes the rest from what
        // Fincra settled. A deposit too small to cover it is credited in full.
        const gross = Number(deposit.sourceAmount);
        const grossAmount = isFinite(gross) && gross >= amount ? round2(gross) : amount;
        const reportedFee = Number(deposit.fee);
        // Fincra's fee as reported, or the gap between sent and settled; unknown falls back to its rule
        const providerTaken = deposit.fee !== undefined && deposit.fee !== null && isFinite(reportedFee) && reportedFee >= 0
            ? reportedFee
            : grossAmount > amount ? round2(grossAmount - amount) : undefined;
        let fee = (await platformSettingsService.priceFunding(grossAmount, providerTaken)).platformFee;
        if (fee >= amount) {
            logger.warn("Deposit smaller than the funding fee; credited without a fee", { reference, amount, fee });
            fee = 0;
        }
        const credit = round2(amount - fee);

        let walletTransaction: WalletTransaction | null;
        try {
            walletTransaction = await withTransaction(async (tx) => {
                // Same lock as the suspense hold: a deposit is either credited or held, never both
                await lockKey(tx, `fincra-deposit:${reference}`);
                if (await journalRepository.existsByExternalRef(SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN, FINCRA, reference, tx)) return null;
                const ourReference = this.walletTransactionService.generateReference("FND");

                // Money entered the platform at Fincra: we owe the user the deposit less our fee
                const legs = [
                    { accountCode: NGN_CASH, direction: JOURNAL_DIRECTION.DEBIT, amount },
                    { accountCode: userWalletAccountCode(target.user, target.currency), direction: JOURNAL_DIRECTION.CREDIT, amount: credit },
                ];
                if (fee > 0) legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: fee });
                await ledgerService.post({
                    legs,
                    source: JOURNAL_SOURCE.FUNDING,
                    reference: ourReference,
                    description: `Wallet funding via Fincra virtual account (${reference})`,
                    externalRef: { provider: FINCRA, id: reference },
                    metadata: { ...details, fundingFee: fee },
                    tx,
                });

                const updated = await walletRepository.credit(target.id, credit, tx, { alsoLedger: true, requireActive: true });
                if (!updated) {
                    throw errorResponseMessage.createError(500, "Failed to update wallet balance", ErrorSeverity.CRITICAL);
                }

                return walletTransactionRepository.create(
                    {
                        wallet: target.id,
                        user: target.user,
                        type: WALLET_TRANSACTION_TYPE.FUNDING,
                        status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                        amount: credit,
                        ...(fee > 0 ? { fee } : {}),
                        reference: ourReference,
                        balanceBefore: round2(updated.balance - credit),
                        balanceAfter: updated.balance,
                        description: deposit.senderAccountName ? `Bank transfer from ${deposit.senderAccountName}` : "Wallet funding via bank transfer",
                        currency: target.currency,
                        // The provider's reference (the column predates Fincra)
                        paystackReference: reference,
                    },
                    tx
                );
            });
        } catch (error) {
            if (isUniqueViolation(error, "wallet_transactions_funding_reference_key")) {
                logger.info("Wallet funding already processed (concurrent duplicate)", { reference });
                return null;
            }
            logger.error("Wallet funding failed", { reference, error: error instanceof Error ? error.message : String(error) });
            throw error;
        }

        if (!walletTransaction) {
            logger.info("Deposit already held in suspense; not credited again", { reference });
            return null;
        }
        logger.info("Wallet funded successfully", { walletId: target.id, amount: credit, fee, reference: walletTransaction.reference });

        // Best-effort: a logging failure does NOT block the funding result.
        try {
            await auditLogService.logAction(
                undefined,
                target.user,
                "funding_received",
                undefined,
                { amount, reference: walletTransaction.reference, providerReference: reference },
                undefined,
                undefined,
                { ...details, walletId: target.id }
            );
        } catch (auditError) {
            logger.warn("Audit log write failed (funding_received)", {
                reference,
                error: auditError instanceof Error ? auditError.message : String(auditError),
            });
        }

        return walletTransaction;
    }

    /**
     * Capture an unmatched funding event in the SUSPENSE ledger so the funds
     * are tracked until an admin attributes them.
     */
    private async recordSuspenseFunding(opts: { reference: string; amount: number; details: Record<string, unknown>; note?: string }): Promise<void> {
        try {
            // Fincra retries webhooks, sometimes two at once: the lock makes the
            // second delivery wait and then find the first one's entry
            const held = await withTransaction(async (tx) => {
                await lockKey(tx, `fincra-deposit:${opts.reference}`);
                if (await journalRepository.existsByExternalRef(SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN, FINCRA, opts.reference, tx)) return false;
                await ledgerService.post({
                    legs: [
                        { accountCode: NGN_CASH, direction: JOURNAL_DIRECTION.DEBIT, amount: opts.amount },
                        { accountCode: SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: opts.amount },
                    ],
                    source: JOURNAL_SOURCE.FUNDING,
                    reference: opts.reference,
                    description: `Unmatched Fincra deposit held in suspense${opts.note ? ` — ${opts.note}` : ""}`,
                    externalRef: { provider: FINCRA, id: opts.reference },
                    metadata: { ...opts.details, note: opts.note },
                    tx,
                });
                return true;
            });
            if (!held) {
                logger.info("Unmatched deposit already held in suspense", { reference: opts.reference });
                return;
            }

            try {
                await auditLogService.logAction(
                    undefined,
                    undefined,
                    "funding_suspense_held",
                    undefined,
                    { amount: opts.amount, providerReference: opts.reference },
                    undefined,
                    undefined,
                    { ...opts.details, note: opts.note }
                );
            } catch (auditError) {
                logger.warn("Audit log write failed (funding_suspense_held)", {
                    reference: opts.reference,
                    error: auditError instanceof Error ? auditError.message : String(auditError),
                });
            }
        } catch (error) {
            logger.error("Failed to record suspense funding entry", {
                reference: opts.reference,
                error: error instanceof Error ? error.message : String(error),
            });
            // Fail the webhook so Fincra delivers it again
            throw error;
        }
    }

    // ===================== WITHDRAWAL =====================

    /** Initiate a withdrawal from the NGN wallet */
    async initiateWithdrawal(
        userId: string,
        amount: number,
        bankCode: string,
        accountNumber: string,
        accountName: string,
        pin: string
    ): Promise<WalletTransaction> {
        await this.verifyPin(userId, pin);

        if (amount < WALLET_LIMITS.MIN_WITHDRAWAL) {
            throw errorResponseMessage.createError(400, `Minimum withdrawal is ₦${WALLET_LIMITS.MIN_WITHDRAWAL.toLocaleString()}`, ErrorSeverity.MEDIUM);
        }
        if (amount > WALLET_LIMITS.MAX_WITHDRAWAL) {
            throw errorResponseMessage.createError(400, `Maximum withdrawal is ₦${WALLET_LIMITS.MAX_WITHDRAWAL.toLocaleString()}`, ErrorSeverity.MEDIUM);
        }

        const dailyTotal = await this.walletTransactionService.getDailyWithdrawalTotal(userId);
        if (dailyTotal + amount > WALLET_LIMITS.DAILY_WITHDRAWAL_LIMIT) {
            throw errorResponseMessage.createError(
                400,
                `Daily withdrawal limit of ₦${WALLET_LIMITS.DAILY_WITHDRAWAL_LIMIT.toLocaleString()} would be exceeded.`,
                ErrorSeverity.MEDIUM
            );
        }

        const wallet = await this.findBaseWallet(userId);
        if (!wallet) throw errorResponseMessage.resourceNotFound("Wallet");

        if (wallet.status !== WALLET_STATUS.ACTIVE) {
            throw errorResponseMessage.createError(400, "Wallet is not active", ErrorSeverity.HIGH);
        }
        // The admin's withdrawal fee (Fincra's passed on + SolutionPay's) is charged on top
        const fee = (await platformSettingsService.priceFees("withdrawal", amount)).total;
        const charge = round2(amount + fee);
        if (wallet.balance < charge) {
            throw errorResponseMessage.createError(
                400,
                fee > 0 ? `Insufficient wallet balance. This withdrawal costs ₦${charge.toLocaleString("en-NG")} including the ₦${fee.toLocaleString("en-NG")} fee.` : "Insufficient wallet balance",
                ErrorSeverity.MEDIUM
            );
        }

        await this.ensureUserLedgerAccount(userId, wallet);

        const reference = this.walletTransactionService.generateReference("WDR");
        const userAccountCode = userWalletAccountCode(userId, wallet.currency);

        // Debit + journal + record commit together; Fincra is called after
        const { walletTransaction, initTxGroupId } = await withTransaction(async (tx) => {
            const updated = await walletRepository.debit(wallet.id, charge, tx);
            if (!updated) {
                throw errorResponseMessage.createError(400, "Insufficient balance or wallet unavailable", ErrorSeverity.HIGH);
            }

            // The user's wallet liability decreases; the money sits in flight until Fincra settles,
            // and the fee is earned now (it's returned if the payout fails)
            const post = await ledgerService.post({
                legs: withdrawalLegs(userAccountCode, amount, fee, "initiate"),
                source: JOURNAL_SOURCE.WITHDRAWAL,
                reference,
                description: `Withdrawal initiated to ${accountName} (${accountNumber})`,
                metadata: { bankCode, accountNumber },
                tx,
            });

            const created = await walletTransactionRepository.create(
                {
                    wallet: wallet.id,
                    user: userId,
                    type: WALLET_TRANSACTION_TYPE.WITHDRAWAL,
                    status: WALLET_TRANSACTION_STATUS.PENDING,
                    amount,
                    ...(fee > 0 ? { fee } : {}),
                    reference,
                    balanceBefore: round2(updated.balance + charge),
                    balanceAfter: updated.balance,
                    description: `Withdrawal to ${accountName} (${accountNumber})`,
                    currency: wallet.currency,
                    paystackReference: reference,
                    recipientBankCode: bankCode,
                    recipientAccountNumber: accountNumber,
                    recipientAccountName: accountName,
                },
                tx
            );
            return { walletTransaction: created, initTxGroupId: post.txGroupId };
        });

        // Fincra is called OUTSIDE the transaction — the balance is already debited.
        // Our reference is the payout's customerReference, so it can't be paid twice.
        try {
            const payout = await fincraService.createPayout({
                customerReference: reference,
                sourceCurrency: "NGN",
                destinationCurrency: "NGN",
                amount,
                paymentDestination: "bank_account",
                description: `Wallet withdrawal ${reference}`,
                beneficiary: {
                    ...splitName(accountName),
                    accountHolderName: accountName,
                    accountNumber,
                    bankCode,
                    country: "NG",
                },
            });
            await walletTransactionRepository.update(walletTransaction.id, {
                status: WALLET_TRANSACTION_STATUS.PROCESSING,
                paystackTransferCode: payout.reference ? String(payout.reference) : reference,
            });
        } catch (providerError: any) {
            // A timeout or server error may still have created the payout: ask
            // Fincra before refunding, so a payout that went out isn't refunded too
            if (!definitelyRejected(providerError)) {
                const existing = await fincraService.getPayout(reference).catch(() => undefined);
                if (existing !== null) {
                    logger.warn("Fincra payout outcome unclear; left processing for the sweeper", { reference, error: providerError?.message });
                    await walletTransactionRepository.update(walletTransaction.id, {
                        status: WALLET_TRANSACTION_STATUS.PROCESSING,
                        ...(existing?.reference ? { paystackTransferCode: String(existing.reference) } : {}),
                    });
                    return walletTransaction;
                }
            }

            logger.error("Fincra payout failed, reversing balance", { reference, error: providerError?.message, fincra: providerError?.fincra });
            try {
                await withTransaction(async (tx) => {
                    await walletRepository.credit(wallet.id, charge, tx);
                    await ledgerService.post({
                        legs: withdrawalLegs(userAccountCode, amount, fee, "reverse"),
                        source: JOURNAL_SOURCE.REVERSAL,
                        reference,
                        description: `Reversal — payout initiation failed`,
                        metadata: { reverses: initTxGroupId },
                        tx,
                    });
                    await walletTransactionRepository.update(
                        walletTransaction.id,
                        {
                            status: WALLET_TRANSACTION_STATUS.FAILED,
                            failureReason: withoutProviderName(providerError?.message, "Transfer initiation failed"),
                        },
                        tx
                    );
                });
            } catch (reverseError) {
                logger.error("Reversal of failed payout initiation also failed", { reference, error: (reverseError as any)?.message });
                throw reverseError;
            }

            const providerMessage: string = providerError?.message || "";
            if (/resolve|invalid account|account number|beneficiary|bank code/i.test(providerMessage)) {
                throw errorResponseMessage.createError(
                    400,
                    "The bank couldn't confirm this account. Check the account number and bank, then try again. Your balance has not been charged.",
                    ErrorSeverity.MEDIUM
                );
            }
            throw errorResponseMessage.createError(500, "We couldn't send this withdrawal right now. Your balance has not been charged. Please try again shortly.", ErrorSeverity.HIGH);
        }

        logger.info("Withdrawal initiated", { walletId: wallet.id, amount, reference });

        try {
            await auditLogService.logAction(
                undefined,
                userId,
                "withdrawal_initiated",
                undefined,
                { amount, reference, accountNumber, bankCode },
                undefined,
                undefined,
                { walletId: wallet.id }
            );
        } catch (auditError) {
            logger.warn("Audit log write failed (withdrawal_initiated)", {
                reference,
                error: auditError instanceof Error ? auditError.message : String(auditError),
            });
        }

        return walletTransaction;
    }

    /**
     * Process a successful withdrawal (Fincra payout.successful, or a status check).
     * Settles the in-flight balance against Paystack cash. Idempotent: the
     * wallet transaction is claimed in the same database transaction, so a
     * webhook and a status poll can't both settle it.
     */
    async processWithdrawalSuccess(transferCode: string, reference: string): Promise<void> {
        const walletTx = await walletTransactionRepository.findByTransferCodeOrReference(transferCode, reference);

        if (!walletTx) {
            logger.warn("Withdrawal success webhook: transaction not found", { transferCode, reference });
            return;
        }
        if (walletTx.status === WALLET_TRANSACTION_STATUS.SUCCESSFUL) {
            logger.info("Withdrawal already marked successful (idempotent)", { reference });
            return;
        }
        if (walletTx.status === WALLET_TRANSACTION_STATUS.FAILED || walletTx.status === WALLET_TRANSACTION_STATUS.REVERSED) {
            // Refunded already, yet Fincra says it paid: the user has the money twice. Needs a person.
            logger.error("CRITICAL: Fincra reports a refunded withdrawal as paid; not settled, reconcile manually", { reference, transferCode, walletTransactionId: walletTx.id });
            return;
        }

        try {
            const settled = await withTransaction(async (tx) => {
                const claimed = await walletTransactionRepository.claim(
                    walletTx.id,
                    WITHDRAWAL_SETTLED,
                    { status: WALLET_TRANSACTION_STATUS.SUCCESSFUL as "successful" },
                    tx
                );
                if (!claimed) return false;

                // Both are assets: in-flight goes down, cash at Fincra goes down (money left Fincra).
                await ledgerService.post({
                    legs: [
                        { accountCode: NGN_PAYOUT_INFLIGHT, direction: JOURNAL_DIRECTION.DEBIT, amount: claimed.amount },
                        { accountCode: NGN_CASH, direction: JOURNAL_DIRECTION.CREDIT, amount: claimed.amount },
                    ],
                    source: JOURNAL_SOURCE.WITHDRAWAL,
                    reference: claimed.reference,
                    description: `Withdrawal paid out by Fincra (${reference})`,
                    externalRef: { provider: FINCRA, id: transferCode || reference },
                    tx,
                });

                // The balance was debited at initiation; the ledger balance follows on settlement
                await walletRepository.adjustLedgerBalance(claimed.wallet, -round2(claimed.amount + (claimed.fee ?? 0)), tx);
                return true;
            });

            if (!settled) {
                logger.info("Withdrawal already marked successful (idempotent)", { reference });
                return;
            }
            logger.info("Withdrawal completed successfully", { reference, amount: walletTx.amount });
        } catch (error) {
            logger.error("Withdrawal success processing failed", { reference, error: (error as any)?.message });
            throw error;
        }

        try {
            await auditLogService.logAction(
                undefined,
                walletTx.user,
                "withdrawal_settled",
                undefined,
                { amount: walletTx.amount, reference, transferCode },
                undefined,
                undefined,
                { walletTransactionId: walletTx.id }
            );
        } catch (auditError) {
            logger.warn("Audit log write failed (withdrawal_settled)", {
                reference,
                error: auditError instanceof Error ? auditError.message : String(auditError),
            });
        }
    }

    /**
     * Process a failed withdrawal (Fincra payout.failed, or a status check).
     * Reverses the balance debit. Idempotent in the same way as success.
     */
    async processWithdrawalFailure(transferCode: string, reference: string, reason?: string): Promise<void> {
        const walletTx = await walletTransactionRepository.findByTransferCodeOrReference(transferCode, reference);

        if (!walletTx) {
            logger.warn("Withdrawal failure webhook: transaction not found", { transferCode, reference });
            return;
        }
        if (walletTx.status === WALLET_TRANSACTION_STATUS.FAILED || walletTx.status === WALLET_TRANSACTION_STATUS.REVERSED) {
            logger.info("Withdrawal already marked failed/reversed (idempotent)", { reference });
            return;
        }
        if (walletTx.status === WALLET_TRANSACTION_STATUS.SUCCESSFUL) {
            // Paid already: refunding now would pay the user twice. Needs a person.
            logger.error("CRITICAL: Fincra reports a paid withdrawal as failed; not refunded, reconcile manually", { reference, transferCode, reason, walletTransactionId: walletTx.id });
            return;
        }

        const reversalRef = this.walletTransactionService.generateReference("REV");
        let reversed: boolean;
        try {
            reversed = await withTransaction(async (tx) => {
                const claimed = await walletTransactionRepository.claim(
                    walletTx.id,
                    WITHDRAWAL_SETTLED,
                    { status: WALLET_TRANSACTION_STATUS.FAILED as "failed", failureReason: withoutProviderName(reason, "Transfer failed") },
                    tx
                );
                if (!claimed) return false;

                // The fee comes back too: the user is charged nothing for a failed withdrawal
                const fee = claimed.fee ?? 0;
                const refund = round2(claimed.amount + fee);
                const wallet = await walletRepository.credit(claimed.wallet, refund, tx);
                if (!wallet) {
                    throw errorResponseMessage.createError(500, "Wallet not found for reversal", ErrorSeverity.CRITICAL);
                }

                await ledgerService.post({
                    legs: withdrawalLegs(userWalletAccountCode(claimed.user, wallet.currency), claimed.amount, fee, "reverse"),
                    source: JOURNAL_SOURCE.REVERSAL,
                    reference: claimed.reference,
                    description: `Reversal — withdrawal ${claimed.reference} failed (${reason || "no reason given"})`,
                    externalRef: { provider: FINCRA, id: transferCode || claimed.reference },
                    metadata: { reverses: claimed.reference, reason },
                    tx,
                });

                await walletTransactionRepository.create(
                    {
                        wallet: claimed.wallet,
                        user: claimed.user,
                        type: WALLET_TRANSACTION_TYPE.REVERSAL,
                        status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                        amount: refund,
                        reference: reversalRef,
                        balanceBefore: round2(wallet.balance - refund),
                        balanceAfter: wallet.balance,
                        description: `Reversal of failed withdrawal (${claimed.reference})`,
                        currency: wallet.currency,
                        reversedTransactionId: claimed.id,
                    },
                    tx
                );
                return true;
            });
        } catch (error) {
            logger.error("Withdrawal reversal failed", { reference, error: (error as any)?.message });
            throw error;
        }

        if (!reversed) {
            logger.info("Withdrawal already marked failed/reversed (idempotent)", { reference });
            return;
        }
        logger.info("Withdrawal reversed", { originalRef: reference, reversalRef, amount: walletTx.amount });

        try {
            await auditLogService.logAction(
                undefined,
                walletTx.user,
                "withdrawal_reversed",
                undefined,
                { amount: walletTx.amount, originalRef: reference, reversalRef, reason },
                undefined,
                undefined,
                { walletTransactionId: walletTx.id }
            );
        } catch (auditError) {
            logger.warn("Audit log write failed (withdrawal_reversed)", {
                reference,
                error: auditError instanceof Error ? auditError.message : String(auditError),
            });
        }
    }

    // ===================== TRANSFER VERIFICATION (Polling fallback) =====================

    /**
     * Check a processing withdrawal with Fincra — the fallback for when the
     * webhook doesn't arrive. Called by the frontend and the sweeper.
     */
    async verifyAndUpdateTransfer(userId: string, transactionId: string): Promise<any> {
        const walletTx = await walletTransactionRepository.findOwned(transactionId, userId, WALLET_TRANSACTION_TYPE.WITHDRAWAL as "withdrawal");
        if (!walletTx) throw errorResponseMessage.resourceNotFound("Transaction");

        if (
            walletTx.status === WALLET_TRANSACTION_STATUS.SUCCESSFUL ||
            walletTx.status === WALLET_TRANSACTION_STATUS.FAILED ||
            walletTx.status === WALLET_TRANSACTION_STATUS.REVERSED
        ) {
            return { transaction: walletTx, message: `Transaction already ${walletTx.status}` };
        }

        let payout: any;
        try {
            payout = await fincraService.getPayout(walletTx.reference);
        } catch (error: any) {
            logger.error("Transfer verification API call failed", { transactionId, error: error?.message });
            throw errorResponseMessage.createError(500, "Unable to verify transfer status with payment provider. Please try again later.", ErrorSeverity.MEDIUM);
        }

        // Fincra has no payout with our reference: it was never created. Refund
        // once it's clearly not just slow to appear.
        if (!payout) {
            const ageMs = Date.now() - new Date(walletTx.createdAt).getTime();
            if (ageMs < 10 * 60 * 1000) return { transaction: walletTx, message: "Transfer is still being set up" };
            logger.warn("Transfer verification: Fincra has no such payout, marking as failed", { transactionId });
            await this.processWithdrawalFailure("", walletTx.reference, "Transfer was never initiated with payment provider");
            const updated = await walletTransactionRepository.findById(transactionId);
            return { transaction: updated, message: "Transfer failed — balance has been refunded" };
        }

        const status = String(payout.status || "").toLowerCase();
        logger.info("Transfer verification result", { reference: walletTx.reference, fincraStatus: status });
        if (status === "successful" || status === "success") {
            await this.processWithdrawalSuccess(String(payout.reference || ""), walletTx.reference);
            const updated = await walletTransactionRepository.findById(transactionId);
            return { transaction: updated, message: "Withdrawal completed successfully" };
        }
        if (status === "failed" || status === "reversed" || status === "cancelled") {
            await this.processWithdrawalFailure(String(payout.reference || ""), walletTx.reference, payout.reason || payout.message || `Transfer ${status}`);
            const updated = await walletTransactionRepository.findById(transactionId);
            return { transaction: updated, message: `Transfer ${status} — balance has been refunded` };
        }
        return { transaction: walletTx, message: `Transfer is still ${status || "processing"} with the payment provider` };
    }

    // ===================== WALLET DEBIT/CREDIT (for other services) =====================

    /**
     * Atomically debit an active wallet. Returns the updated wallet.
     * Throws if the balance is insufficient or the wallet is unavailable.
     */
    async debitBalance(walletId: string, amount: number, tx?: Executor): Promise<Wallet> {
        const updated = await walletRepository.debit(walletId, amount, tx);
        if (!updated) {
            throw errorResponseMessage.createError(400, "Insufficient wallet balance or wallet unavailable", ErrorSeverity.HIGH);
        }
        return updated;
    }

    /** Credit a wallet (e.g. a refund), optionally inside the caller's transaction */
    async creditBalance(walletId: string, amount: number, tx?: Executor): Promise<Wallet | undefined> {
        return walletRepository.credit(walletId, amount, tx);
    }

    /** Move the ledger balance after a confirmed settlement */
    async adjustLedgerBalance(walletId: string, amount: number, tx?: Executor): Promise<Wallet | undefined> {
        return walletRepository.adjustLedgerBalance(walletId, amount, tx);
    }

    // ===================== QUERIES =====================

    async getWalletBalance(userId: string) {
        const wallet = await this.getOrCreateWallet(userId);
        return {
            balance: wallet.balance,
            ledgerBalance: wallet.ledgerBalance,
            currency: wallet.currency,
            status: wallet.status,
        };
    }

    /** Paginated wallet transaction history, newest first */
    async getTransactionHistory(userId: string, options: { page: number; limit: number; type?: string; currency?: string }) {
        let wallet: string | null | undefined;
        if (options.currency) {
            const found = await walletRepository.findByUserAndCurrency(userId, options.currency.toUpperCase());
            // An unopened wallet has no history
            wallet = found?.id ?? null;
        }
        const request: PageRequest = { page: options.page, limit: options.limit };
        return walletTransactionRepository.paginateForUser({ user: userId, type: options.type, wallet }, request);
    }

    /** Nigerian banks Fincra pays out to, in the shape the app has always used */
    async listBanks() {
        const banks = await fincraService.listBanks("NG", "NGN", "bank_account");
        return banks.map((b) => ({ name: b.name, code: b.code, slug: b.code, active: true, country: "Nigeria", currency: "NGN", type: "nuban" }));
    }

    /** The name on a Nigerian bank account */
    async resolveAccount(accountNumber: string, bankCode: string) {
        try {
            const account = await fincraService.resolveAccount({ currency: "NGN", accountNumber, bankCode });
            return { account_name: account.accountName, account_number: account.accountNumber };
        } catch (error) {
            if (error instanceof FincraError && error.status < 500) {
                throw errorResponseMessage.createError(404, "We couldn't find that account. Check the number and bank.", ErrorSeverity.LOW);
            }
            throw error;
        }
    }
}

export default WalletService;
