import { and, asc, count, desc, eq, gte, inArray } from "drizzle-orm";
import { verifications } from "../db/schema";
import type { Verification } from "../types/entities";
import type { VerificationKind, VerificationStatus } from "../types/enums";
import { definedOnly, exec, isUuid, stripNulls } from "./utils";

type VerificationRow = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;
export type VerificationUpdate = Partial<Omit<NewVerification, "id" | "user" | "createdAt" | "updatedAt">>;

/** Columns only read when deciding a check (Mongoose `select: false`) */
const SECRET_COLUMNS = ["idHash", "bvnEnc", "ninEnc", "ninHash"] as const;

export const ENCRYPTED_IDS_CLEARED = { bvnEnc: null, ninEnc: null, ninHash: null } as const;

function toVerification(row: VerificationRow, withSecrets = false): Verification {
    const plain = stripNulls(row);
    if (!withSecrets) for (const column of SECRET_COLUMNS) delete plain[column];
    return plain;
}

class VerificationRepository {
    async create(data: NewVerification): Promise<Verification> {
        const [row] = await exec().insert(verifications).values(data).returning();
        return toVerification(row);
    }

    async findById(id: string, options: { withSecrets?: boolean } = {}): Promise<Verification | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec().select().from(verifications).where(eq(verifications.id, id)).limit(1);
        return row ? toVerification(row, options.withSecrets) : undefined;
    }

    async findPendingBvn(userId: string): Promise<Verification | undefined> {
        if (!isUuid(userId)) return undefined;
        const [row] = await exec()
            .select()
            .from(verifications)
            .where(and(eq(verifications.user, userId), eq(verifications.kind, "bvn"), eq(verifications.status, "pending")))
            .limit(1);
        return row ? toVerification(row) : undefined;
    }

    async isPending(id: string): Promise<boolean> {
        const [row] = await exec()
            .select({ id: verifications.id })
            .from(verifications)
            .where(and(eq(verifications.id, id), eq(verifications.status, "pending")))
            .limit(1);
        return !!row;
    }

    /** Failed BVN checks since `since` that count towards the attempt limit, oldest first */
    async countedFailuresSince(userId: string, since: Date): Promise<Array<{ id: string; createdAt: Date }>> {
        if (!isUuid(userId)) return [];
        return exec()
            .select({ id: verifications.id, createdAt: verifications.createdAt })
            .from(verifications)
            .where(
                and(
                    eq(verifications.user, userId),
                    eq(verifications.kind, "bvn"),
                    eq(verifications.status, "failed"),
                    eq(verifications.excludedFromAttempts, false),
                    gte(verifications.createdAt, since)
                )
            )
            .orderBy(asc(verifications.createdAt));
    }

    async countSince(userId: string, kind: VerificationKind, since: Date): Promise<number> {
        const [row] = await exec()
            .select({ n: count() })
            .from(verifications)
            .where(and(eq(verifications.user, userId), eq(verifications.kind, kind), gte(verifications.createdAt, since)));
        return Number(row?.n ?? 0);
    }

    /** Newest first, never secrets */
    async listForUser(userId: string, limit: number): Promise<Verification[]> {
        if (!isUuid(userId)) return [];
        const rows = await exec().select().from(verifications).where(eq(verifications.user, userId)).orderBy(desc(verifications.createdAt)).limit(limit);
        return rows.map((row) => toVerification(row));
    }

    async update(id: string, patch: VerificationUpdate): Promise<void> {
        await exec().update(verifications).set(definedOnly(patch as Record<string, unknown>)).where(eq(verifications.id, id));
    }

    /** Update only while the check is still pending; returns whether it changed */
    async updateIfPending(id: string, patch: VerificationUpdate): Promise<boolean> {
        const rows = await exec()
            .update(verifications)
            .set(definedOnly(patch as Record<string, unknown>))
            .where(and(eq(verifications.id, id), eq(verifications.status, "pending")))
            .returning({ id: verifications.id });
        return rows.length > 0;
    }

    async updateManyForUser(userId: string, filter: { status?: VerificationStatus; kind?: VerificationKind }, patch: VerificationUpdate): Promise<number> {
        const where = [eq(verifications.user, userId)];
        if (filter.status) where.push(eq(verifications.status, filter.status));
        if (filter.kind) where.push(eq(verifications.kind, filter.kind));
        const rows = await exec().update(verifications).set(definedOnly(patch as Record<string, unknown>)).where(and(...where)).returning({ id: verifications.id });
        return rows.length;
    }

    async updateMany(ids: string[], patch: VerificationUpdate): Promise<void> {
        const valid = ids.filter(isUuid);
        if (!valid.length) return;
        await exec().update(verifications).set(definedOnly(patch as Record<string, unknown>)).where(inArray(verifications.id, valid));
    }

    /** Most recent check for a user, or undefined */
    async latestForUser(userId: string): Promise<Verification | undefined> {
        const [first] = await this.listForUser(userId, 1);
        return first;
    }
}

export const verificationRepository = new VerificationRepository();
export default verificationRepository;
