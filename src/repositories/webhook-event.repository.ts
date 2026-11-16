import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { webhookEvents } from "../db/schema";
import type { Executor } from "../db/client";
import type { WebhookEvent } from "../types/entities";
import type { WebhookProvider, WebhookStatus } from "../types/enums";
import { pageWindow, toPage, type PageRequest, type Paginated } from "../db/pagination";
import { definedOnly, exec, isUuid, stripNulls } from "./utils";

export type NewWebhookEvent = typeof webhookEvents.$inferInsert;

export interface WebhookEventFilter {
    provider?: string;
    status?: string;
    event?: string;
    externalId?: string;
    receivedFrom?: Date;
    receivedTo?: Date;
}

class WebhookEventRepository {
    async create(data: NewWebhookEvent, tx?: Executor): Promise<WebhookEvent> {
        const [row] = await exec(tx).insert(webhookEvents).values(data).returning();
        return stripNulls(row);
    }

    async findById(id: string): Promise<WebhookEvent | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec().select().from(webhookEvents).where(eq(webhookEvents.id, id)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async update(
        id: string,
        patch: { status?: WebhookStatus; processedAt?: Date; error?: string | null; txGroupId?: string }
    ): Promise<void> {
        if (!isUuid(id)) return;
        await exec().update(webhookEvents).set(definedOnly(patch)).where(eq(webhookEvents.id, id));
    }

    /** Newest first */
    async paginate(filter: WebhookEventFilter, request: PageRequest): Promise<Paginated<WebhookEvent>> {
        const window = pageWindow(request, { limit: 25 });
        const where: SQL[] = [];
        if (filter.provider) where.push(eq(webhookEvents.provider, filter.provider as WebhookProvider));
        if (filter.status) where.push(eq(webhookEvents.status, filter.status as WebhookStatus));
        if (filter.event) where.push(eq(webhookEvents.event, filter.event));
        if (filter.externalId) where.push(eq(webhookEvents.externalId, filter.externalId));
        if (filter.receivedFrom && !isNaN(filter.receivedFrom.getTime())) where.push(gte(webhookEvents.receivedAt, filter.receivedFrom));
        if (filter.receivedTo && !isNaN(filter.receivedTo.getTime())) where.push(lte(webhookEvents.receivedAt, filter.receivedTo));
        const condition = where.length ? and(...where) : undefined;
        const [rows, [{ n }]] = await Promise.all([
            exec().select().from(webhookEvents).where(condition).orderBy(desc(webhookEvents.receivedAt), desc(webhookEvents.id)).limit(window.limit).offset(window.offset),
            exec().select({ n: count() }).from(webhookEvents).where(condition),
        ]);
        return toPage(rows.map(stripNulls), Number(n), window);
    }
}

export const webhookEventRepository = new WebhookEventRepository();
export default webhookEventRepository;
