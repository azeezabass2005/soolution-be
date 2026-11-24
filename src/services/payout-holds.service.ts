import { and, count, desc, eq, inArray } from "drizzle-orm";
import { payoutHolds } from "../db/schema";
import { exec, isUuid } from "../repositories/utils";
import userRepository from "../repositories/user.repository";
import platformSettingsService from "./platform-settings.service";
import inboxService from "./inbox.service";
import NotificationService from "../utils/notification.utils";
import config from "../config/env.config";
import logger from "../utils/logger.utils";
import attentionService from "./attention.service";
import { hasPermission } from "../common/permissions";

export type HoldKind = "yellowcard_send" | "ghs_send" | "withdrawal";
export type PayoutHold = typeof payoutHolds.$inferSelect;

const formatNgn = (n: number) => `₦${n.toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;

/**
 * Whether a payout needs an admin first, and the holds waiting for one. The
 * send and withdrawal flows ask `needsApproval` once the money is taken; if
 * it does, they call `hold` instead of the provider. Approving and rejecting
 * live in approval.service (they need the flows to finish the job).
 */
class PayoutHoldsService {
    private notifications = new NotificationService();

    /** The approval limit for this user (NGN): their own, else the platform's; null = never held */
    async thresholdFor(userId: string): Promise<number | null> {
        const [user, ops] = await Promise.all([userRepository.findById(userId), platformSettingsService.getOperations()]);
        if (!user || user.approvalExempt) return null;
        const own = user.approvalThresholdNgn;
        const limit = typeof own === "number" && own > 0 ? own : ops.approvals.thresholdNgn;
        return limit > 0 ? limit : null;
    }

    /** Over the limit: the payout waits for an admin */
    async needsApproval(userId: string, amountNgn: number): Promise<boolean> {
        const limit = await this.thresholdFor(userId);
        return limit !== null && amountNgn > limit;
    }

    /** Records the hold and tells the team (in the app and by email) */
    async hold(input: {
        kind: HoldKind;
        userId: string;
        transactionId?: string;
        walletTransactionId?: string;
        reference: string;
        amountNgn: number;
        amount: number;
        currency: string;
        recipient?: string;
        payload: Record<string, any>;
    }): Promise<PayoutHold> {
        const [row] = await exec().insert(payoutHolds).values({
            kind: input.kind,
            user: input.userId,
            transactionId: input.transactionId,
            walletTransactionId: input.walletTransactionId,
            reference: input.reference,
            amountNgn: input.amountNgn,
            amount: input.amount,
            currency: input.currency,
            recipient: input.recipient,
            payload: input.payload,
        }).returning();
        const what = input.kind === "withdrawal" ? "withdrawal" : `${input.currency} send`;
        const message = `${input.reference}: ${formatNgn(input.amountNgn)} ${what}${input.recipient ? ` to ${input.recipient}` : ""} is over the approval limit. The money is held from the customer's wallet until you approve or reject it.`;
        Promise.resolve().then(() => this.notifications.notifyAdmins(config.ADMIN_EMAILS, {
            title: `Approval needed: ${formatNgn(input.amountNgn)} ${what}`,
            message,
            type: "approval.needed",
            permission: "transactions",
            actionUrl: `${config.FRONTEND_URL}/dashboard/admin/transactions?tab=approvals`,
            buttonText: "Review it",
        } as any, config.ADMIN_PHONE_NUMBERS)).catch(() => undefined);
        logger.info("Payout held for approval", { holdId: row.id, kind: input.kind, reference: input.reference, amountNgn: input.amountNgn });
        return row;
    }

    async list(status: "pending" | "decided" = "pending", limit = 100) {
        const statuses = status === "pending" ? ["pending", "approving"] : ["approved", "rejected", "failed"];
        return exec().select().from(payoutHolds).where(inArray(payoutHolds.status, statuses as any)).orderBy(desc(payoutHolds.createdAt)).limit(limit);
    }

    /** Whether a wallet withdrawal is waiting for approval */
    async isHeld(walletTransactionId: string): Promise<boolean> {
        if (!isUuid(walletTransactionId)) return false;
        const [row] = await exec().select({ id: payoutHolds.id }).from(payoutHolds)
            .where(and(eq(payoutHolds.walletTransactionId, walletTransactionId), inArray(payoutHolds.status, ["pending", "approving"] as any))).limit(1);
        return !!row;
    }

    async pendingCount(): Promise<number> {
        const [row] = await exec().select({ n: count() }).from(payoutHolds).where(eq(payoutHolds.status, "pending"));
        return Number(row?.n ?? 0);
    }

    /** Takes a pending hold for deciding (only one admin can); undefined if it's gone or decided */
    async claim(id: string, by: string): Promise<PayoutHold | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec().update(payoutHolds).set({ status: "approving", decidedBy: by, decidedAt: new Date() })
            .where(and(eq(payoutHolds.id, id), eq(payoutHolds.status, "pending"))).returning();
        return row;
    }

    async finish(id: string, status: "approved" | "rejected" | "failed", note?: string) {
        await exec().update(payoutHolds).set({ status, note: note ?? null }).where(eq(payoutHolds.id, id));
    }

    /** The customer hears what happened */
    async tellUser(hold: PayoutHold, outcome: "approved" | "rejected" | "failed", reason?: string) {
        const what = hold.kind === "withdrawal" ? "withdrawal" : "transfer";
        await inboxService.toUser(hold.user, {
            type: `approval.${outcome}`,
            title: outcome === "approved" ? `Your ${what} is on its way` : `Your ${what} wasn't sent`,
            body: outcome === "approved"
                ? `${hold.reference} was approved and is being sent.`
                : `${hold.reference}: ${reason || "it couldn't be completed"}. The money is back in your wallet.`,
            link: hold.kind === "withdrawal" ? "/dashboard/user/wallet" : "/dashboard/user/transactions",
        });
    }
}

const payoutHoldsService = new PayoutHoldsService();

// Held payouts put a red dot on Transactions for admins who handle them
attentionService.register(async (access): Promise<Record<string, number>> => (hasPermission(access, "transactions") ? { pendingApprovals: await payoutHoldsService.pendingCount() } : {}));

export default payoutHoldsService;
