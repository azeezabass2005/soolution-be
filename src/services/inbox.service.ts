import { and, count, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { notifications } from "../db/schema";
import { exec, isUuid } from "../repositories/utils";
import type { Permission } from "../common/permissions";
import logger from "../utils/logger.utils";

export interface InboxMessage {
    type: string;
    title: string;
    body?: string;
    /** An app path (or a full URL to the app; the origin is dropped) */
    link?: string;
    data?: Record<string, unknown>;
}

/** Keep notifications short in the bell; the full story is on the page they link to */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
/** Emails carry HTML; the bell shows plain text */
const plain = (text?: string) => String(text ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
/** Our own pages only: "https://app.example/dashboard/x?y" → "/dashboard/x?y" */
const toPath = (link?: string) => {
    if (!link) return null;
    try {
        if (link.startsWith("/")) return link;
        const url = new URL(link);
        return `${url.pathname}${url.search}`;
    } catch {
        return null;
    }
};
/** Strip emoji the email titles start with */
const cleanTitle = (title: string) => plain(title).replace(/^[\p{Extended_Pictographic}️\s]+/u, "");

/**
 * The in-app notification inbox for users and admins. Writing never throws:
 * a notification that can't be stored is logged, and whatever triggered it
 * carries on.
 */
class InboxService {
    private async insert(userIds: string[], audience: "user" | "admin", message: InboxMessage) {
        const ids = [...new Set(userIds.filter((id) => isUuid(id)))];
        if (!ids.length) return;
        try {
            await exec().insert(notifications).values(ids.map((user) => ({
                user,
                audience,
                type: message.type,
                title: clip(cleanTitle(message.title), 140),
                body: clip(plain(message.body), 500),
                link: toPath(message.link),
                data: message.data,
            })));
        } catch (error: any) {
            logger.warn("Couldn't store an in-app notification", { type: message.type, error: error?.message });
        }
    }

    /** A user's own news (payment done, KYC decision, …) */
    async toUser(userId: string | undefined | null, message: InboxMessage) {
        if (userId) await this.insert([userId], "user", message);
    }

    /** An alert for every admin whose role covers `permission` (super admins always) */
    async toTeam(permission: Permission, message: InboxMessage) {
        try {
            const { default: adminAccessService } = await import("./admin-access.service");
            await this.insert(await adminAccessService.teamWith(permission), "admin", message);
        } catch (error: any) {
            logger.warn("Couldn't notify the team", { type: message.type, error: error?.message });
        }
    }

    /** Newest first; `before` (an id) pages further back */
    async list(userId: string, options: { limit?: number; before?: string } = {}) {
        const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
        let beforeDate: Date | undefined;
        if (options.before && isUuid(options.before)) {
            const [row] = await exec().select({ at: notifications.createdAt }).from(notifications)
                .where(and(eq(notifications.id, options.before), eq(notifications.user, userId))).limit(1);
            beforeDate = row?.at;
        }
        const rows = await exec().select().from(notifications)
            .where(and(eq(notifications.user, userId), beforeDate ? lt(notifications.createdAt, beforeDate) : undefined))
            .orderBy(desc(notifications.createdAt), desc(notifications.id))
            .limit(limit + 1);
        return {
            items: rows.slice(0, limit).map((r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, link: r.link, data: r.data ?? null, read: !!r.readAt, createdAt: r.createdAt })),
            hasMore: rows.length > limit,
            unread: await this.unreadCount(userId),
        };
    }

    async unreadCount(userId: string): Promise<number> {
        if (!isUuid(userId)) return 0;
        const [row] = await exec().select({ n: count() }).from(notifications).where(and(eq(notifications.user, userId), isNull(notifications.readAt)));
        return Number(row?.n ?? 0);
    }

    /** Marks the given notifications read (or all of them) */
    async markRead(userId: string, ids?: string[] | "all") {
        const where = ids === "all" || !ids
            ? and(eq(notifications.user, userId), isNull(notifications.readAt))
            : and(eq(notifications.user, userId), inArray(notifications.id, ids.filter((id) => isUuid(id))), isNull(notifications.readAt));
        if (Array.isArray(ids) && !ids.some((id) => isUuid(id))) return { unread: await this.unreadCount(userId) };
        await exec().update(notifications).set({ readAt: sql`now()` }).where(where);
        return { unread: await this.unreadCount(userId) };
    }
}

export default new InboxService();
