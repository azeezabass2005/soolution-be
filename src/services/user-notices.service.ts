import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { paymentLinks, transactionDetails, transactions, walletTransactions } from "../db/schema";
import { exec } from "../repositories/utils";
import userRepository from "../repositories/user.repository";
import NotificationService from "../utils/notification.utils";
import config from "../config/env.config";
import logger from "../utils/logger.utils";

const FINAL_TX = ["completed", "successful", "failed", "cancelled"];
const FINAL_WALLET = ["successful", "failed", "reversed"];
const LOOKBACK = sql`now() - interval '7 days'`;
/** Settled at least this long ago, so paths that tell the user themselves (markTold) go first */
const GRACE_SECONDS = 10;

const amount = (currency: string | null | undefined, value: unknown) =>
    `${currency || ""} ${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();

export interface Notice {
    type: string;
    title: string;
    message: string;
    link: string;
}

type Tx = typeof transactions.$inferSelect;
type Detail = typeof transactionDetails.$inferSelect;
type WalletTx = typeof walletTransactions.$inferSelect;

/**
 * Tells users how their money movements ended: every send, receive, deposit
 * and withdrawal that reaches a final status gets exactly one notice (in the
 * app, by email and WhatsApp where set up), whichever code path finished it.
 * `notified_status` records what they were told, so a row is claimed once.
 */
class UserNoticesService {
    private notifications = new NotificationService();
    private running = false;

    /** What to tell the user about a transaction in its current status, or null for nothing */
    transactionNotice(t: Tx, d: Partial<Detail> | null, linkTitle?: string | null): Notice | null {
        const ref = t.reference;
        const link = "/dashboard/user/transactions";
        const reason = t.cancelReason ? ` Reason: ${t.cancelReason}.` : "";
        // Receives: the payer's money in its currency, credited to the naira wallet
        if (t.currency === "NGN" && t.fromCurrency !== "NGN") {
            if (t.status !== "completed" && t.status !== "successful") return null; // the payer not finishing isn't news
            const credited = Number(d?.fromAmount) > 0 ? ` ${amount("NGN", d!.fromAmount)} has been added to your NGN wallet.` : " It's been added to your NGN wallet.";
            // A top-up: money the user paid in themselves
            if (t.purpose === "top_up") {
                return { type: "transaction.top_up", title: "Your top-up arrived", message: `The ${amount(t.fromCurrency, t.amount)} you paid in has arrived.${credited} Reference: ${ref}.`, link };
            }
            const from = t.payerName ? ` from ${t.payerName}` : "";
            const forWhat = linkTitle ? ` for "${linkTitle}"` : t.paymentLink ? " through your payment link" : "";
            return { type: "transaction.received", title: "Payment received", message: `You received ${amount(t.fromCurrency, t.amount)}${from}${forWhat}.${credited} Reference: ${ref}.`, link };
        }
        const recipient = d?.accountName || d?.momoName || d?.alipayName || null;
        const to = recipient ? ` to ${recipient}` : "";
        const what = `${amount(t.currency, t.amount)}${to}`;
        if (t.status === "completed" || t.status === "successful") {
            return { type: "transaction.completed", title: "Money sent", message: `${what} has been paid. Reference: ${ref}.`, link };
        }
        if (t.status === "failed") {
            return { type: "transaction.failed", title: "Your transfer didn't go through", message: `${what} couldn't be paid.${reason} If money left your wallet for it, it's been returned. Reference: ${ref}.`, link };
        }
        if (t.status === "cancelled") {
            return { type: "transaction.cancelled", title: "Your transfer was cancelled", message: `${what} was cancelled.${reason} Reference: ${ref}.`, link };
        }
        return null;
    }

    /** What to tell the user about a deposit or withdrawal, or null */
    walletNotice(w: WalletTx): Notice | null {
        const cur = w.currency || "NGN";
        const link = "/dashboard/user/wallet";
        // Money from a transaction (a receive, a top-up) is told once, by the transaction's own notice
        if (w.type === "funding" && w.transactionId) return null;
        if (w.type === "funding" && w.status === "successful") {
            return { type: "wallet.funded", title: "Your wallet has been funded", message: `${amount(cur, w.amount)} has been added to your ${cur} wallet. Your balance is now ${amount(cur, w.balanceAfter)}. Reference: ${w.reference}.`, link };
        }
        if (w.type !== "withdrawal") return null;
        const to = w.recipientAccountName ? ` to ${w.recipientAccountName}${w.recipientBankName ? ` (${w.recipientBankName})` : ""}` : "";
        if (w.status === "successful") {
            return { type: "withdrawal.completed", title: "Withdrawal paid", message: `${amount(cur, w.amount)}${to} has been paid. Reference: ${w.reference}.`, link };
        }
        const reason = w.failureReason ? ` Reason: ${w.failureReason}.` : "";
        return { type: "withdrawal.failed", title: "Your withdrawal didn't go through", message: `${amount(cur, w.amount)}${to} couldn't be paid.${reason} The money is back in your wallet. Reference: ${w.reference}.`, link };
    }

    /** For a path that tells the user itself (e.g. with a receipt attached): don't tell them again */
    async markTold(kind: "transaction" | "wallet", id: string, status: string) {
        if (kind === "transaction") await exec().update(transactions).set({ notifiedStatus: status }).where(eq(transactions.id, id));
        else await exec().update(walletTransactions).set({ notifiedStatus: status }).where(eq(walletTransactions.id, id));
    }

    /** Sends whatever hasn't been told yet; returns how many notices went out. Runs every few seconds. */
    async run(options: { graceSeconds?: number } = {}): Promise<number> {
        if (this.running) return 0;
        const graceSeconds = options.graceSeconds ?? GRACE_SECONDS;
        // Zero (tests): no wait at all; otherwise compare on the database clock
        const settled = (column: unknown) => (graceSeconds > 0 ? sql`${column} < clock_timestamp() - make_interval(secs => ${graceSeconds})` : undefined);
        this.running = true;
        let sent = 0;
        try {
            const due = await exec().select({ id: transactions.id }).from(transactions)
                .where(and(inArray(transactions.status, FINAL_TX as any), or(isNull(transactions.notifiedStatus), ne(transactions.notifiedStatus, transactions.status)), sql`coalesce(${transactions.completedAt}, ${transactions.failedAt}, ${transactions.initiatedAt}) > ${LOOKBACK}`, settled(sql`coalesce(${transactions.updatedAt}, ${transactions.initiatedAt})`)))
                .limit(100);
            for (const { id } of due) {
                // Claim it: only one notice per final status, however many workers run
                const [t] = await exec().update(transactions).set({ notifiedStatus: sql`${transactions.status}` as any })
                    .where(and(eq(transactions.id, id), or(isNull(transactions.notifiedStatus), ne(transactions.notifiedStatus, transactions.status)))).returning();
                if (!t) continue;
                const [d] = await exec().select().from(transactionDetails).where(eq(transactionDetails.transactionId, id)).limit(1);
                const [link] = t.paymentLink ? await exec().select({ title: paymentLinks.title }).from(paymentLinks).where(eq(paymentLinks.id, t.paymentLink)).limit(1) : [];
                if (await this.send(t.user, this.transactionNotice(t, d ?? null, link?.title ?? null), { transactionId: id, status: t.status })) sent += 1;
            }

            const dueWallet = await exec().select({ id: walletTransactions.id, told: walletTransactions.notifiedStatus }).from(walletTransactions)
                .where(and(inArray(walletTransactions.type, ["funding", "withdrawal"] as any), inArray(walletTransactions.status, FINAL_WALLET as any), or(isNull(walletTransactions.notifiedStatus), ne(walletTransactions.notifiedStatus, walletTransactions.status)), sql`${walletTransactions.createdAt} > ${LOOKBACK}`, settled(sql`coalesce(${walletTransactions.updatedAt}, ${walletTransactions.createdAt})`)))
                .limit(100);
            for (const { id, told } of dueWallet) {
                const [w] = await exec().update(walletTransactions).set({ notifiedStatus: sql`${walletTransactions.status}` as any })
                    .where(and(eq(walletTransactions.id, id), or(isNull(walletTransactions.notifiedStatus), ne(walletTransactions.notifiedStatus, walletTransactions.status)))).returning();
                if (!w) continue;
                // A withdrawal that failed and was then reversed is one story: it was told at "failed"
                if (w.status === "reversed" && told === "failed") continue;
                if (await this.send(w.user, this.walletNotice(w), { walletTransactionId: id, status: w.status })) sent += 1;
            }
        } catch (error: any) {
            logger.warn("User notices: run failed", { error: error?.message });
        } finally {
            this.running = false;
        }
        return sent;
    }

    private async send(userId: string, notice: Notice | null, data: Record<string, unknown>): Promise<boolean> {
        if (!notice) return false;
        try {
            const user = await userRepository.findById(userId);
            if (!user) return false;
            await this.notifications.sendNotification(user as any, {
                type: notice.type,
                title: notice.title,
                message: notice.message,
                actionUrl: `${config.FRONTEND_URL}${notice.link}`,
                buttonText: "View details",
                data,
            } as any);
            return true;
        } catch (error: any) {
            logger.warn("User notice failed", { userId, type: notice.type, error: error?.message });
            return false;
        }
    }
}

export default new UserNoticesService();
