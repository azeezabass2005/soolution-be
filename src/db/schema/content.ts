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
