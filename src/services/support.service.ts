import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import z from "zod";
import { supportMessages, supportTickets, transactions, users } from "../db/schema";
import { exec, isUuid } from "../repositories/utils";
import userRepository from "../repositories/user.repository";
import inboxService from "./inbox.service";
import attentionService from "./attention.service";
import NotificationService from "../utils/notification.utils";
import { hasPermission, type Permission } from "../common/permissions";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import config from "../config/env.config";
import logger from "../utils/logger.utils";

export type TicketKind = "support" | "dispute";
export type TicketStatus = "open" | "answered" | "investigating" | "resolved" | "rejected";
type Ticket = typeof supportTickets.$inferSelect;

/** Who on the team handles each kind */
export const TICKET_PERMISSION: Record<TicketKind, Permission> = { support: "support", dispute: "transactions.disputes" };
/** Waiting on the team */
const WAITING_ON_US: Record<TicketKind, TicketStatus[]> = { support: ["open"], dispute: ["open", "investigating"] };
const CLOSED: TicketStatus[] = ["resolved", "rejected"];
const STATUSES: Record<TicketKind, TicketStatus[]> = { support: ["open", "answered", "resolved"], dispute: ["open", "investigating", "resolved", "rejected"] };

const bad = (message: string) => errorResponseMessage.createError(400, message, ErrorSeverity.LOW);
const notFound = () => errorResponseMessage.resourceNotFound("Conversation");

const ZOpen = z.object({
    kind: z.enum(["support", "dispute"]).default("support"),
    subject: z.string({ required_error: "Add a subject" }).trim().min(3, "Add a short subject").max(140, "Keep the subject under 140 characters"),
    body: z.string({ required_error: "Tell us what's going on" }).trim().min(5, "Tell us a little more").max(5000, "Keep it under 5,000 characters"),
    transactionId: z.string().uuid("Choose the transaction").optional(),
});
const ZBody = z.string({ required_error: "Write a message" }).trim().min(1, "Write a message").max(5000, "Keep it under 5,000 characters");

const parse = <T>(schema: z.ZodType<T, any, any>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw bad(result.error.issues[0].message);
    return result.data;
};

/**
 * Support conversations and transaction disputes between users and the
 * team. Each side hears about the other's messages (in the app, and by
 * email for the user).
 */
class SupportService {
    private notifications = new NotificationService();

    private view(t: Ticket, extra: Record<string, unknown> = {}) {
        return {
            id: t.id, kind: t.kind, subject: t.subject, status: t.status, transactionId: t.transactionId ?? null,
            resolution: t.resolution ?? null, assignedTo: t.assignedTo ?? null, lastMessageAt: t.lastMessageAt, createdAt: t.createdAt, ...extra,
        };
    }

    private async messages(ticketId: string) {
        const rows = await exec().select().from(supportMessages).where(eq(supportMessages.ticket, ticketId)).orderBy(asc(supportMessages.createdAt));
        return rows.map((m) => ({ id: m.id, fromTeam: m.fromTeam, body: m.body, createdAt: m.createdAt }));
    }

    // ─────────────── Users ───────────────

    async open(userId: string, body: unknown) {
        const data = parse(ZOpen, body ?? {});
        if (data.kind === "dispute") {
            if (!data.transactionId) throw bad("Choose the transaction you're disputing");
            const [tx] = await exec().select({ id: transactions.id, reference: transactions.reference }).from(transactions)
                .where(and(eq(transactions.id, data.transactionId), eq(transactions.user, userId))).limit(1);
            if (!tx) throw errorResponseMessage.resourceNotFound("Transaction");
            const [existing] = await exec().select({ id: supportTickets.id }).from(supportTickets)
                .where(and(eq(supportTickets.transactionId, tx.id), eq(supportTickets.kind, "dispute"), sql`${supportTickets.status} not in ('resolved', 'rejected')`)).limit(1);
            if (existing) throw errorResponseMessage.createError(409, "There's already an open dispute for this transaction. Add to it instead.", ErrorSeverity.LOW, { ticketId: existing.id });
        }
        const [ticket] = await exec().insert(supportTickets).values({
            user: userId, kind: data.kind, subject: data.subject, transactionId: data.kind === "dispute" ? data.transactionId : null,
        }).returning();
        await exec().insert(supportMessages).values({ ticket: ticket.id, author: userId, fromTeam: false, body: data.body });
        await this.tellTeam(ticket, `New ${ticket.kind === "dispute" ? "dispute" : "support request"}: ${ticket.subject}`, data.body);
        return this.view(ticket, { messages: await this.messages(ticket.id) });
    }

    async listMine(userId: string, kind?: TicketKind) {
        const rows = await exec().select().from(supportTickets)
            .where(and(eq(supportTickets.user, userId), kind ? eq(supportTickets.kind, kind) : undefined))
            .orderBy(desc(supportTickets.lastMessageAt)).limit(100);
        return rows.map((t) => this.view(t));
    }

    async getMine(userId: string, id: string) {
        const ticket = await this.find(id);
        if (!ticket || ticket.user !== userId) throw notFound();
        return this.view(ticket, { messages: await this.messages(ticket.id) });
    }

    async replyAsUser(userId: string, id: string, body: unknown) {
        const text = parse(ZBody, body);
        const ticket = await this.find(id);
        if (!ticket || ticket.user !== userId) throw notFound();
        if (CLOSED.includes(ticket.status)) throw errorResponseMessage.createError(409, "This conversation is closed. Start a new one if you still need help.", ErrorSeverity.LOW);
        await exec().insert(supportMessages).values({ ticket: ticket.id, author: userId, fromTeam: false, body: text });
        // Back with the team
        const status: TicketStatus = ticket.kind === "support" ? "open" : ticket.status;
        const [updated] = await exec().update(supportTickets).set({ status, lastMessageAt: new Date() }).where(eq(supportTickets.id, ticket.id)).returning();
        await this.tellTeam(updated, `Reply from the customer: ${ticket.subject}`, text);
        return this.view(updated, { messages: await this.messages(ticket.id) });
    }

    // ─────────────── Team ───────────────

    /** Kinds this admin may handle */
    kindsFor(access: Parameters<typeof hasPermission>[0]): TicketKind[] {
        return (["support", "dispute"] as TicketKind[]).filter((k) => hasPermission(access, TICKET_PERMISSION[k]));
    }

    async listForTeam(kinds: TicketKind[], filter: { kind?: TicketKind; status?: string } = {}) {
        const allowed = filter.kind ? kinds.filter((k) => k === filter.kind) : kinds;
        if (!allowed.length) return [];
        const where: SQL[] = [inArray(supportTickets.kind, allowed)];
        if (filter.status === "waiting") {
            where.push(sql`${supportTickets.status} in ('open', 'investigating')`);
        } else if (filter.status === "closed") {
            where.push(inArray(supportTickets.status, CLOSED));
        } else if (filter.status && filter.status !== "all") {
            where.push(eq(supportTickets.status, filter.status as TicketStatus));
        }
        const rows = await exec()
            .select({ t: supportTickets, firstName: users.firstName, lastName: users.lastName, email: users.email, reference: transactions.reference })
            .from(supportTickets)
            .leftJoin(users, eq(users.id, supportTickets.user))
            .leftJoin(transactions, eq(transactions.id, supportTickets.transactionId))
            .where(and(...where))
            .orderBy(desc(supportTickets.lastMessageAt))
            .limit(200);
        return rows.map((r) => this.view(r.t, {
            user: { id: r.t.user, name: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(), email: r.email },
            transactionReference: r.reference ?? null,
        }));
    }

    async getForTeam(kinds: TicketKind[], id: string) {
        const ticket = await this.find(id);
        if (!ticket || !kinds.includes(ticket.kind)) throw notFound();
        const user = await userRepository.findById(ticket.user);
        const [tx] = ticket.transactionId ? await exec().select().from(transactions).where(eq(transactions.id, ticket.transactionId)).limit(1) : [];
        return this.view(ticket, {
            messages: await this.messages(ticket.id),
            user: user ? { id: user.id, name: `${user.firstName} ${user.lastName}`.trim(), email: user.email } : null,
            transaction: tx ? { id: tx.id, reference: tx.reference, amount: tx.amount, currency: tx.currency, fromCurrency: tx.fromCurrency, status: tx.status, createdAt: tx.createdAt } : null,
            statuses: STATUSES[ticket.kind],
        });
    }

    async replyAsTeam(kinds: TicketKind[], adminId: string, id: string, body: unknown) {
        const text = parse(ZBody, body);
        const ticket = await this.find(id);
        if (!ticket || !kinds.includes(ticket.kind)) throw notFound();
        await exec().insert(supportMessages).values({ ticket: ticket.id, author: adminId, fromTeam: true, body: text });
        // Support: now waiting on the user. Disputes: being looked at.
        const status: TicketStatus = CLOSED.includes(ticket.status) ? ticket.status : ticket.kind === "support" ? "answered" : "investigating";
        const [updated] = await exec().update(supportTickets).set({ status, lastMessageAt: new Date(), assignedTo: ticket.assignedTo ?? adminId }).where(eq(supportTickets.id, ticket.id)).returning();
        await this.tellUser(updated, `New reply: ${ticket.subject}`, text);
        return this.getForTeam(kinds, ticket.id);
    }

    /** Changes the status (and for disputes, records how it ended) */
    async setStatus(kinds: TicketKind[], adminId: string, id: string, body: unknown) {
        const ticket = await this.find(id);
        if (!ticket || !kinds.includes(ticket.kind)) throw notFound();
        const status = String((body as any)?.status ?? "") as TicketStatus;
        if (!STATUSES[ticket.kind].includes(status)) throw bad(`Choose one of: ${STATUSES[ticket.kind].join(", ")}`);
        const resolution = String((body as any)?.resolution ?? "").trim().slice(0, 1000) || null;
        if (ticket.kind === "dispute" && CLOSED.includes(status) && !resolution) throw bad("Say how the dispute ended (the customer sees it)");
        const [updated] = await exec().update(supportTickets).set({ status, resolution: resolution ?? ticket.resolution, assignedTo: ticket.assignedTo ?? adminId, lastMessageAt: new Date() })
            .where(eq(supportTickets.id, ticket.id)).returning();
        logger.info("Support conversation status changed", { ticketId: ticket.id, adminId, from: ticket.status, to: status });
        if (CLOSED.includes(status)) {
            const label = ticket.kind === "dispute" ? (status === "resolved" ? "Your dispute was resolved" : "Your dispute was closed") : "Your support request was resolved";
            await this.tellUser(updated, `${label}: ${ticket.subject}`, resolution ?? "");
        }
        return this.getForTeam(kinds, ticket.id);
    }

    /** Conversations waiting on the team, by kind */
    async waitingCounts(): Promise<Record<TicketKind, number>> {
        const rows = await exec().select({ kind: supportTickets.kind, n: count() }).from(supportTickets)
            .where(sql`(${supportTickets.kind} = 'support' and ${supportTickets.status} = 'open') or (${supportTickets.kind} = 'dispute' and ${supportTickets.status} in ('open', 'investigating'))`)
            .groupBy(supportTickets.kind);
        const out: Record<TicketKind, number> = { support: 0, dispute: 0 };
        for (const r of rows) out[r.kind as TicketKind] = Number(r.n);
        return out;
    }

    /** A user's open disputes by transaction, to show on their transactions */
    async disputesFor(userId: string, transactionIds: string[]) {
        const ids = transactionIds.filter((id) => isUuid(id));
        if (!ids.length) return [];
        return exec().select({ id: supportTickets.id, transactionId: supportTickets.transactionId, status: supportTickets.status })
            .from(supportTickets).where(and(eq(supportTickets.user, userId), eq(supportTickets.kind, "dispute"), inArray(supportTickets.transactionId, ids)));
    }

    // ─────────────── Plumbing ───────────────

    private async find(id: string): Promise<Ticket | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec().select().from(supportTickets).where(eq(supportTickets.id, id)).limit(1);
        return row;
    }

    private async tellTeam(ticket: Ticket, title: string, body: string) {
        const link = ticket.kind === "dispute" ? `/dashboard/admin/transactions?tab=disputes&ticket=${ticket.id}` : `/dashboard/admin/support?ticket=${ticket.id}`;
        await inboxService.toTeam(TICKET_PERMISSION[ticket.kind], { type: `${ticket.kind}.message`, title, body, link, data: { ticketId: ticket.id } });
    }

    private async tellUser(ticket: Ticket, title: string, body: string) {
        const user = await userRepository.findById(ticket.user);
        if (!user) return;
        const link = `/dashboard/user/support?ticket=${ticket.id}`;
        // In the app, and by email (sendNotification does both, and WhatsApp where set up)
        await this.notifications.sendNotification(user as any, {
            title, message: body || "Open the conversation to see it.", actionUrl: `${config.FRONTEND_URL}${link}`, buttonText: "Open conversation", type: `${ticket.kind}.reply`,
        } as any).catch(async (error: any) => {
            logger.warn("Support reply notification failed", { ticketId: ticket.id, error: error?.message });
            await inboxService.toUser(user.id, { type: `${ticket.kind}.reply`, title, body, link });
        });
    }
}

const supportService = new SupportService();

// Waiting conversations put red dots on Support and Transactions → Disputes
attentionService.register(async (access): Promise<Record<string, number>> => {
    const kinds = supportService.kindsFor(access);
    if (!kinds.length) return {};
    const counts = await supportService.waitingCounts();
    return {
        ...(kinds.includes("support") ? { openTickets: counts.support } : {}),
        ...(kinds.includes("dispute") ? { openDisputes: counts.dispute } : {}),
    };
});

export default supportService;
