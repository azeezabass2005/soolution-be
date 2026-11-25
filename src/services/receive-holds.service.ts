import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { transactions, users } from "../db/schema";
import { exec } from "../repositories/utils";
import { withTransaction } from "../db/transaction";
import walletRepository from "../repositories/wallet.repository";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { BASE_WALLET_CURRENCY } from "../common/wallet.constants";
import inboxService from "./inbox.service";
import logger from "../utils/logger.utils";

const money = (n: number) => `₦${n.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Large receives held for checks (see TransactionService.holdLargeReceive):
 * listing them for admins, and releasing one so its naira can be withdrawn.
 */
class ReceiveHoldsService {
    /** Held receives (oldest first, so the longest-waiting are seen first), or recently released ones */
    async list(status: "held" | "released" = "held", limit = 100) {
        const rows = await exec()
            .select({ t: transactions, name: sql<string>`trim(coalesce(${users.firstName}, '') || ' ' || coalesce(${users.lastName}, ''))`, email: users.email })
            .from(transactions)
            .innerJoin(users, eq(users.id, transactions.user))
            .where(and(isNotNull(transactions.heldAmount), status === "held" ? isNull(transactions.heldReleasedAt) : isNotNull(transactions.heldReleasedAt)))
            .orderBy(status === "held" ? transactions.completedAt : desc(transactions.heldReleasedAt))
            .limit(limit);
        return rows.map(({ t, name, email }) => ({
            id: t.id,
            reference: t.reference,
            userId: t.user,
            userName: name || email,
            userEmail: email,
            amount: Number(t.amount),
            currency: t.fromCurrency,
            heldAmount: Number(t.heldAmount),
            receivedAt: t.completedAt,
            releasedAt: t.heldReleasedAt,
            releasedBy: t.heldReleasedBy,
        }));
    }

    /** Lets the naira of a held receive be withdrawn; once only */
    async release(transactionId: string, adminId: string) {
        const released = await withTransaction(async (tx) => {
            const [row] = await exec(tx)
                .update(transactions)
                .set({ heldReleasedAt: new Date(), heldReleasedBy: adminId })
                .where(and(eq(transactions.id, transactionId), isNotNull(transactions.heldAmount), isNull(transactions.heldReleasedAt)))
                .returning();
            if (!row) return null;
            const wallet = await walletRepository.findByUserAndCurrency(row.user, BASE_WALLET_CURRENCY, tx);
            if (!wallet) throw errorResponseMessage.createError(500, "The user's naira wallet wasn't found", ErrorSeverity.CRITICAL);
            await walletRepository.release(wallet.id, Number(row.heldAmount), tx);
            return row;
        });
        if (!released) {
            throw errorResponseMessage.createError(409, "This receive isn't held (it may already have been released).", ErrorSeverity.LOW);
        }
        const amount = Number(released.heldAmount);
        logger.info("Held receive released", { transactionId, reference: released.reference, amount, adminId });
        await inboxService.toUser(released.user, {
            type: "receive.released",
            title: "Your naira is ready to withdraw",
            body: `The checks on ${released.reference} are done: ${money(amount)} can now be withdrawn or sent.`,
            link: "/dashboard/user/wallet",
            data: { reference: released.reference },
        }).catch(() => undefined);
        return { id: released.id, reference: released.reference, heldAmount: amount, releasedAt: released.heldReleasedAt };
    }
}

export default new ReceiveHoldsService();
