import { and, arrayContains, count, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { posts, tags, users } from "../db/schema";
import type { Post, PublicUser, Tag } from "../types/entities";
import type { PublicationStatus } from "../types/enums";
import { pageWindow, toPage, type PageRequest, type Paginated } from "../db/pagination";
import { definedOnly, exec, isUuid, stripNulls } from "./utils";
import { toPublicUser, toUser } from "./user.repository";

export type PostUpdate = Partial<Pick<typeof posts.$inferInsert, "title" | "content" | "tags" | "category" | "publicationStatus">>;
export type PostWithUser = Omit<Post, "user"> & { user: PublicUser | string };
export type RelatedPost = PostWithUser & {
    scores: { category: number; tags: number; text: number; engagement: number; timeDecay: number; final: number };
};

export interface PostFilter {
    category?: string;
    publicationStatus?: string;
    user?: string;
    tag?: string;
}

class PostRepository {
    private async withUsers(rows: Post[]): Promise<PostWithUser[]> {
        const ids = [...new Set(rows.map((row) => row.user))];
        if (!ids.length) return [];
        const owners = await exec().select().from(users).where(inArray(users.id, ids));
        const byId = new Map(owners.map((row) => [row.id, toPublicUser(toUser(row))]));
        return rows.map((row) => ({ ...row, user: byId.get(row.user) ?? row.user }));
    }

    async findById(id: string): Promise<PostWithUser | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec().select().from(posts).where(eq(posts.id, id)).limit(1);
        if (!row) return undefined;
        const [withUser] = await this.withUsers([stripNulls(row)]);
        return withUser;
    }

    /** Newest first, with the author */
    async paginate(filter: PostFilter, request: PageRequest): Promise<Paginated<PostWithUser>> {
        const window = pageWindow(request);
        const where: SQL[] = [];
        if (filter.category) where.push(eq(posts.category, filter.category));
        if (filter.publicationStatus) where.push(eq(posts.publicationStatus, filter.publicationStatus as PublicationStatus));
        if (filter.user) {
            if (!isUuid(filter.user)) return toPage([], 0, window);
            where.push(eq(posts.user, filter.user));
        }
        if (filter.tag) where.push(arrayContains(posts.tags, [filter.tag]));
        const condition = where.length ? and(...where) : undefined;
        const [rows, [{ n }]] = await Promise.all([
            exec().select().from(posts).where(condition).orderBy(desc(posts.createdAt), desc(posts.id)).limit(window.limit).offset(window.offset),
            exec().select({ n: count() }).from(posts).where(condition),
        ]);
        return toPage(await this.withUsers(rows.map(stripNulls)), Number(n), window);
    }

    async update(id: string, patch: PostUpdate): Promise<Post | undefined> {
        if (!isUuid(id)) return undefined;
        const values = definedOnly(patch);
        if (!Object.keys(values).length) {
            const [row] = await exec().select().from(posts).where(eq(posts.id, id)).limit(1);
            return row ? stripNulls(row) : undefined;
        }
        const [row] = await exec().update(posts).set(values).where(eq(posts.id, id)).returning();
        return row ? stripNulls(row) : undefined;
    }

    async incrementCounter(id: string, field: "viewCount" | "likeCount", by: number): Promise<void> {
        if (!isUuid(id)) return;
        const column = field === "viewCount" ? posts.viewCount : posts.likeCount;
        await exec().update(posts).set({ [field]: sql`greatest(${column} + ${by}, 0)` }).where(eq(posts.id, id));
    }

    /**
     * Posts related to `post`, ranked by shared category, shared tags, full-text
     * similarity, engagement and recency (the same weighting the Mongo
     * aggregation used). Only posts with some text overlap are returned.
     */
    async findRelated(
        post: Pick<Post, "id" | "user" | "category" | "tags" | "title" | "content">,
        options: { limit: number; includeSameUser: boolean; weights: { category: number; tag: number; text: number; engagement: number; timeDecay: number } }
    ): Promise<RelatedPost[]> {
        const { weights } = options;
        const query = sql`websearch_to_tsquery('english', ${`${post.title} ${post.content}`.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).join(" or ")})`;
        const document = sql`to_tsvector('english', ${posts.title} || ' ' || ${posts.content})`;
        const category = sql<number>`(case when ${posts.category} = ${post.category} then ${weights.category} else 0 end)::float8`;
        const ownTags = post.tags?.length ? sql`array[${sql.join(post.tags.map((tag) => sql`${tag}`), sql`, `)}]::text[]` : sql`'{}'::text[]`;
        const tagScore = sql<number>`(cardinality(array(select unnest(${posts.tags}) intersect select unnest(${ownTags}))) * ${weights.tag})::float8`;
        const text = sql<number>`(ts_rank(${document}, ${query}) * ${weights.text})::float8`;
        const engagement = sql<number>`(((${posts.viewCount} + ${posts.likeCount} * 2) / 100.0) * ${weights.engagement})::float8`;
        const timeDecay = sql<number>`((1.0 / (1 + extract(epoch from (now() - ${posts.createdAt})) / 86400.0)) * ${weights.timeDecay})::float8`;
        const final = sql<number>`(${category} + ${tagScore} + ${text} + ${engagement} + ${timeDecay})::float8`;

        const where: SQL[] = [ne(posts.id, post.id), sql`${document} @@ ${query}`];
        if (!options.includeSameUser) where.push(ne(posts.user, post.user));

        const rows = await exec()
            .select({ post: posts, category, tags: tagScore, text, engagement, timeDecay, final })
            .from(posts)
            .where(and(...where))
            .orderBy(sql`${final} desc`)
            .limit(options.limit);
        const withUsers = await this.withUsers(rows.map((row) => stripNulls(row.post)));
        return withUsers.map((item, index) => ({
            ...item,
            scores: {
                category: Number(rows[index].category),
                tags: Number(rows[index].tags),
                text: Number(rows[index].text),
                engagement: Number(rows[index].engagement),
                timeDecay: Number(rows[index].timeDecay),
                final: Number(rows[index].final),
            },
        }));
    }
}

class TagRepository {
    async create(title: string): Promise<Tag> {
        const [row] = await exec().insert(tags).values({ title }).returning();
        return stripNulls(row);
    }

    async list(limit = 300): Promise<Tag[]> {
        const rows = await exec().select().from(tags).orderBy(desc(tags.createdAt)).limit(limit);
        return rows.map(stripNulls);
    }
}

export const postRepository = new PostRepository();
export const tagRepository = new TagRepository();
export default postRepository;
