import { desc, eq } from "drizzle-orm";
import { auditLogs } from "../db/schema";
import type { Executor } from "../db/client";
import type { AuditLog } from "../types/entities";
import { exec, isUuid, stripNulls } from "./utils";

export interface NewAuditLog {
    transactionId?: string;
    userId?: string;
    action: string;
    beforeValue?: unknown;
    afterValue?: unknown;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
}

class AuditLogRepository {
    async create(data: NewAuditLog, tx?: Executor): Promise<AuditLog> {
        const [row] = await exec(tx)
            .insert(auditLogs)
            .values({
                ...data,
                // Ids that aren't ours (e.g. a provider's) are dropped rather than failing the write
                transactionId: isUuid(data.transactionId) ? data.transactionId : undefined,
                userId: isUuid(data.userId) ? data.userId : undefined,
            })
            .returning();
        return stripNulls(row);
    }

    async listForTransaction(transactionId: string, limit = 50): Promise<AuditLog[]> {
        if (!isUuid(transactionId)) return [];
        const rows = await exec().select().from(auditLogs).where(eq(auditLogs.transactionId, transactionId)).orderBy(desc(auditLogs.createdAt)).limit(limit);
        return rows.map(stripNulls);
    }

    async listForUser(userId: string, limit = 50): Promise<AuditLog[]> {
        if (!isUuid(userId)) return [];
        const rows = await exec().select().from(auditLogs).where(eq(auditLogs.userId, userId)).orderBy(desc(auditLogs.createdAt)).limit(limit);
        return rows.map(stripNulls);
    }
}

export const auditLogRepository = new AuditLogRepository();
export default auditLogRepository;
