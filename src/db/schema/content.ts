import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { decimal, id, timestamps, timestamptz } from "../columns";
import { users } from "./users";
import type { ExperienceLevel, PartnerRole, PartnerStatus, PublicationStatus } from "../../types/enums";

export const tags = pgTable("tags", {
    id: id(),
    title: text("title").notNull(),
    ...timestamps(),
});

export const posts = pgTable(
    "posts",
    {
        id: id(),
        title: text("title").notNull(),
        content: text("content").notNull(),
        tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
        category: text("category").notNull(),
        user: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        viewCount: integer("view_count").notNull().default(0),
        likeCount: integer("like_count").notNull().default(0),
        publicationStatus: text("publication_status").$type<PublicationStatus>().notNull().default("draft"),
        ...timestamps(),
    },
    (t) => [
        index("posts_user_idx").on(t.user),
        index("posts_search_idx").using("gin", sql`to_tsvector('english', ${t.title} || ' ' || ${t.content})`),
    ]
);

export interface PartnerRoleData {
    subjects?: string[];
    hourlyRate?: number;
    fleetSize?: number;
    coverageAreas?: string[];
    specialties?: string[];
    portfolio?: string[];
    socialLinks?: Record<string, string>;
    availableForHire?: boolean;
    products?: string[];
    categories?: string[];
    minimumOrderQty?: number;
    deliveryRegions?: string[];
    certifications?: string[];
    skills?: string[];
    experienceLevel?: ExperienceLevel;
    yearsOfExperience?: number;
    talents?: string[];
    awards?: string[];
    agentContact?: string;
    availableForGigs?: boolean;
    [key: string]: unknown;
}

export const partners = pgTable(
    "partners",
    {
        id: id(),
        name: text("name").notNull(),
        email: text("email").notNull().unique("partners_email_key"),
        phone: text("phone"),
        whatsappNumber: text("whatsapp_number"),
        country: text("country").notNull(),
        city: text("city"),
        role: text("role").$type<PartnerRole>().notNull(),
        status: text("status").$type<PartnerStatus>().notNull().default("pending"),
        description: text("description"),
        profileImage: text("profile_image"),
        website: text("website"),
        isVerified: boolean("is_verified").notNull().default(false),
        rating: decimal("rating"),
        totalReviews: integer("total_reviews").notNull().default(0),
        roleData: jsonb("role_data").$type<PartnerRoleData>().notNull().default({}),
        isAvailable: boolean("is_available").notNull().default(true),
        lastActiveAt: timestamptz("last_active_at"),
        joinedAt: timestamptz("joined_at").notNull().defaultNow(),
        ...timestamps(),
    },
    (t) => [
        index("partners_role_status_idx").on(t.role, t.status, t.isAvailable),
        index("partners_location_idx").on(t.country, t.city),
        index("partners_rating_idx").on(t.rating),
    ]
);

/**
 * In-app notifications: one row per person who should see it (a user's own
 * news, or an alert for each admin whose role covers it). Unread until
 * read_at is set.
 */
export const notifications = pgTable(
    "notifications",
    {
        id: id(),
        user: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        /** "user" for a customer's own news, "admin" for team alerts */
        audience: text("audience").$type<"user" | "admin">().notNull().default("user"),
        /** What happened, e.g. "transaction.completed", "kyc.submitted" */
        type: text("type").notNull(),
        title: text("title").notNull(),
        body: text("body").notNull().default(""),
        /** Where clicking it goes, an app path like /dashboard/user/transactions */
        link: text("link"),
        data: jsonb("data").$type<Record<string, unknown>>(),
        readAt: timestamptz("read_at"),
        ...timestamps(),
    },
    (t) => [
        index("notifications_user_idx").on(t.user, t.createdAt),
        index("notifications_unread_idx").on(t.user).where(sql`${t.readAt} is null`),
    ]
);

/**
 * Conversations between a user and the team: support tickets, and disputes
 * about one of the user's transactions.
 *   support: open (waiting on us) → answered (waiting on the user) → resolved
 *   dispute: open → investigating → resolved | rejected
 */
export const supportTickets = pgTable(
    "support_tickets",
    {
        id: id(),
        user: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        kind: text("kind").$type<"support" | "dispute">().notNull().default("support"),
        subject: text("subject").notNull(),
        status: text("status").$type<"open" | "answered" | "investigating" | "resolved" | "rejected">().notNull().default("open"),
        /** Disputes: the transaction it's about */
        transactionId: uuid("transaction_id"),
        /** Who on the team is handling it */
        assignedTo: uuid("assigned_to"),
        /** How it ended, shown to the user (disputes) */
        resolution: text("resolution"),
        lastMessageAt: timestamptz("last_message_at").notNull().defaultNow(),
        ...timestamps(),
    },
    (t) => [
        index("support_tickets_user_idx").on(t.user, t.lastMessageAt),
        index("support_tickets_status_idx").on(t.kind, t.status, t.lastMessageAt),
    ]
);

export const supportMessages = pgTable(
    "support_messages",
    {
        id: id(),
        ticket: uuid("ticket_id").notNull().references(() => supportTickets.id, { onDelete: "cascade" }),
        author: uuid("author_id").notNull(),
        /** Written by the team (shown as "Solution Pay"), not the user */
        fromTeam: boolean("from_team").notNull().default(false),
        body: text("body").notNull(),
        ...timestamps(),
    },
    (t) => [index("support_messages_ticket_idx").on(t.ticket, t.createdAt)]
);

/**
 * Everything an admin changes: each POST/PUT/PATCH/DELETE they make, with the
 * outcome, where from, and the request (secrets removed). Super admins read it
 * under Roles & staff → Activity.
 */
export const adminActivity = pgTable(
    "admin_activity",
    {
        id: id(),
        adminId: uuid("admin_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        method: text("method").notNull(),
        path: text("path").notNull(),
        /** What it was, in words, when we know the route */
        action: text("action"),
        status: integer("status").notNull(),
        ipAddress: text("ip_address"),
        userAgent: text("user_agent"),
        body: jsonb("body"),
        createdAt: timestamptz("created_at").notNull().defaultNow(),
    },
    (t) => [index("admin_activity_admin_idx").on(t.adminId, t.createdAt), index("admin_activity_created_idx").on(t.createdAt)]
);
