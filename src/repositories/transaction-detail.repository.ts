import { eq } from "drizzle-orm";
import { transactionDetails } from "../db/schema";
import type { Executor } from "../db/client";
import type { TransactionDetail } from "../types/entities";
import { definedOnly, exec, isUuid, stripNulls } from "./utils";

export type NewTransactionDetail = typeof transactionDetails.$inferInsert;
export type TransactionDetailUpdate = Partial<Omit<NewTransactionDetail, "id" | "transactionId" | "createdAt" | "updatedAt">>;

class TransactionDetailRepository {
    async create(data: NewTransactionDetail, tx?: Executor): Promise<TransactionDetail> {
        const [row] = await exec(tx).insert(transactionDetails).values(data).returning();
        return stripNulls(row);
    }

    async findByTransactionId(transactionId: string, tx?: Executor): Promise<TransactionDetail | undefined> {
        if (!isUuid(transactionId)) return undefined;
        const [row] = await exec(tx).select().from(transactionDetails).where(eq(transactionDetails.transactionId, transactionId)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findByYcSequenceId(sequenceId: string): Promise<TransactionDetail | undefined> {
        const [row] = await exec().select().from(transactionDetails).where(eq(transactionDetails.ycSequenceId, sequenceId)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findByOgReference(reference: string): Promise<TransactionDetail | undefined> {
        const [row] = await exec().select().from(transactionDetails).where(eq(transactionDetails.ogReference, reference)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async updateByTransactionId(transactionId: string, patch: TransactionDetailUpdate, tx?: Executor): Promise<TransactionDetail | undefined> {
        if (!isUuid(transactionId)) return undefined;
        const values = definedOnly(patch as Record<string, unknown>);
        if (!Object.keys(values).length) return this.findByTransactionId(transactionId, tx);
        const [row] = await exec(tx).update(transactionDetails).set(values).where(eq(transactionDetails.transactionId, transactionId)).returning();
        return row ? stripNulls(row) : undefined;
    }

    async update(id: string, patch: TransactionDetailUpdate, tx?: Executor): Promise<TransactionDetail | undefined> {
        if (!isUuid(id)) return undefined;
        const values = definedOnly(patch as Record<string, unknown>);
        if (!Object.keys(values).length) return undefined;
        const [row] = await exec(tx).update(transactionDetails).set(values).where(eq(transactionDetails.id, id)).returning();
        return row ? stripNulls(row) : undefined;
    }
}

export const transactionDetailRepository = new TransactionDetailRepository();
export default transactionDetailRepository;
