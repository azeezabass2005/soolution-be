import { count, eq, inArray } from "drizzle-orm";
import { transactions } from "../db/schema";
import { exec } from "../repositories/utils";
import { hasPermission, type AdminAccess } from "../common/permissions";
import type { TransactionStatus } from "../types/enums";

/**
 * What needs an admin's attention right now, for the red dots in the admin
 * sidebar and top bar. Each count is only for admins whose role covers it.
 * Later phases add their own (approvals, support tickets, disputes).
 */
class AttentionService {
    private extra: Array<(access: AdminAccess) => Promise<Record<string, number>>> = [];

    /** Lets another feature add its counts (e.g. support tickets) */
    register(counter: (access: AdminAccess) => Promise<Record<string, number>>) {
        this.extra.push(counter);
    }

    async forAdmin(access: AdminAccess): Promise<Record<string, number>> {
        const out: Record<string, number> = {};
        if (hasPermission(access, "transactions")) {
            // Manual payments waiting on us to pay out or confirm
            const [row] = await exec().select({ n: count() }).from(transactions)
                .where(inArray(transactions.status, ["awaiting_confirmation"] as TransactionStatus[]));
            out.pendingTransactions = Number(row?.n ?? 0);
        }
        for (const counter of this.extra) Object.assign(out, await counter(access).catch(() => ({})));
        return out;
    }
}

export const attentionService = new AttentionService();
export default attentionService;
