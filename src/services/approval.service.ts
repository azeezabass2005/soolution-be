import payoutHoldsService, { type PayoutHold } from "./payout-holds.service";
import walletSendService from "./wallet-send.service";
import identityService from "./identity.service";
import transactionRepository from "../repositories/transaction.repository";
import transactionDetailRepository from "../repositories/transaction-detail.repository";
import userRepository from "../repositories/user.repository";
import { SYSTEM_ACCOUNT_CODES, TRANSACTION_STATUS, WEBHOOK_PROVIDER, fincraPayoutInflightCode } from "../common/constant";
import type { TransactionStatus } from "../types/enums";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import logger from "../utils/logger.utils";

const gone = () => errorResponseMessage.createError(409, "Someone has already decided this one, or it no longer exists.", ErrorSeverity.LOW);

/**
 * Approving or rejecting a large payout held for an admin. Approving sends it
 * through the same code a payout under the limit uses; rejecting (or a
 * provider refusing it) returns the money to the user's wallet. Only one admin
 * can decide a hold: the first to claim it.
 */
class ApprovalService {
    private async services() {
        const [{ default: TransactionService }, { default: WalletService }] = await Promise.all([
            import("./transaction.service"),
            import("./wallet.service"),
        ]);
        return { transactions: new TransactionService(), wallets: new WalletService() };
    }

    async approve(holdId: string, adminId: string) {
        const hold = await payoutHoldsService.claim(holdId, adminId);
        if (!hold) throw gone();
        logger.info("Admin approved a held payout", { holdId, adminId, kind: hold.kind, reference: hold.reference });
        try {
            await this.send(hold);
            await payoutHoldsService.finish(hold.id, "approved");
            await payoutHoldsService.tellUser(hold, "approved");
            return { id: hold.id, outcome: "approved" as const, message: "Approved and sent." };
        } catch (error: any) {
            // The payout code already refunded the wallet when the provider refused
            const reason = error?.message || "The provider refused it";
            await payoutHoldsService.finish(hold.id, "failed", reason);
            await payoutHoldsService.tellUser(hold, "failed", reason);
            logger.error("Approved payout failed at the provider; refunded", { holdId, reference: hold.reference, error: error?.message });
            return { id: hold.id, outcome: "failed" as const, message: `Approved, but it couldn't be sent: ${reason}. The money went back to the customer's wallet.` };
        }
    }

    private async send(hold: PayoutHold) {
        const { transactions, wallets } = await this.services();
        const ctx = hold.payload.ctx;
        if (hold.kind === "withdrawal") {
            await wallets.sendWithdrawalPayout({ id: hold.walletTransactionId! }, ctx);
            return;
        }
        // Back to pending, so the payout code moves it on exactly as it would have at once
        const released = await transactionRepository.updateIfStatus(hold.transactionId!, TRANSACTION_STATUS.AWAITING_APPROVAL as TransactionStatus, { status: TRANSACTION_STATUS.PENDING as TransactionStatus });
        if (!released) throw new Error("The transaction isn't waiting for approval any more");
        const transaction = await transactionRepository.findById(hold.transactionId!);
        const details = await transactionDetailRepository.findByTransactionId(hold.transactionId!);
        if (hold.kind === "yellowcard_send") {
            const kycPerson = await identityService.yellowCardPerson(hold.user);
            await transactions.submitYellowCardSend(ctx, kycPerson, transaction, details);
        } else {
            await transactions.submitGhsPayout(ctx, transaction, details);
        }
    }

    async reject(holdId: string, adminId: string, rawReason: unknown) {
        const reason = String(rawReason ?? "").trim().slice(0, 300);
        if (reason.length < 3) throw errorResponseMessage.createError(400, "Say why it's rejected (the customer sees it).", ErrorSeverity.LOW);
        const hold = await payoutHoldsService.claim(holdId, adminId);
        if (!hold) throw gone();
        logger.info("Admin rejected a held payout", { holdId, adminId, kind: hold.kind, reference: hold.reference, reason });

        if (hold.kind === "withdrawal") {
            const { wallets } = await this.services();
            await wallets.processWithdrawalFailure("", hold.reference, `Rejected: ${reason}`);
        } else {
            await transactionRepository.updateIfStatus(hold.transactionId!, TRANSACTION_STATUS.AWAITING_APPROVAL as TransactionStatus, {
                status: TRANSACTION_STATUS.FAILED as TransactionStatus, failedAt: new Date(), cancelReason: reason,
            } as any);
            await transactionDetailRepository.updateByTransactionId(hold.transactionId!, hold.kind === "yellowcard_send" ? { ycStatus: "failed" } as any : { providerStatus: "failed" });
            await walletSendService.refund(hold.walletTransactionId!, `Rejected: ${reason}`, hold.kind === "yellowcard_send"
                ? { feeAmount: Number(hold.payload.ctx?.feeAmount) || 0, providerAccountCode: SYSTEM_ACCOUNT_CODES.YC_FLOAT_NGN, externalRef: { provider: WEBHOOK_PROVIDER.YELLOWCARD, id: hold.reference } }
                : { providerAccountCode: fincraPayoutInflightCode("GHS"), externalRef: { provider: WEBHOOK_PROVIDER.FINCRA, id: hold.reference } });
        }
        await payoutHoldsService.finish(hold.id, "rejected", reason);
        await payoutHoldsService.tellUser(hold, "rejected", reason);
        return { id: hold.id, outcome: "rejected" as const, message: "Rejected. The money went back to the customer's wallet." };
    }

    /** Held payouts with who they're for */
    async list(status: "pending" | "decided") {
        const holds = await payoutHoldsService.list(status);
        const people = new Map((await userRepository.findManyByIds([...new Set(holds.map((h) => h.user))])).map((u) => [u.id, u]));
        return holds.map((h) => {
            const u = people.get(h.user);
            return {
                id: h.id, kind: h.kind, reference: h.reference, status: h.status, note: h.note,
                amountNgn: h.amountNgn, amount: h.amount, currency: h.currency, recipient: h.recipient,
                transactionId: h.transactionId, createdAt: h.createdAt, decidedAt: h.decidedAt,
                user: u ? { id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email } : { id: h.user, name: "", email: "" },
            };
        });
    }
}

export default new ApprovalService();
