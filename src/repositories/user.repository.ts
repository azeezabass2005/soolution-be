import { and, count, desc, eq, ilike, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { users, userTierHistory } from "../db/schema";
import type { Executor } from "../db/client";
import type { PublicUser, User, UserIdentity, UserTierHistoryEntry } from "../types/entities";
import type { UserTier } from "../common/tier.constants";
import type { IdentityStatus } from "../common/identity.constants";
import { definedOnly, escapeLike, exec, isUuid, stripNulls } from "./utils";

type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** Columns a caller may change through `update` (identity has its own method) */
export type UserUpdate = Partial<
    Omit<NewUser, "id" | "createdAt" | "updatedAt" | `identity${string}`>
>;

export interface FindUserOptions {
    /** Include password, PIN hash and the identity hashes / encrypted numbers */
    withSecrets?: boolean;
}

const IDENTITY_COLUMNS = {
    status: "identityStatus",
    bvnHash: "identityBvnHash",
    bvnLast4: "identityBvnLast4",
    bvnEnc: "identityBvnEnc",
    ninEnc: "identityNinEnc",
    ninHash: "identityNinHash",
    ninLast4: "identityNinLast4",
    dob: "identityDob",
    idPhone: "identityIdPhone",
    address: "identityAddress",
    detailsUpdatedAt: "identityDetailsUpdatedAt",
    verifiedName: "identityVerifiedName",
    verifiedAt: "identityVerifiedAt",
    method: "identityMethod",
    failureReason: "identityFailureReason",
} as const satisfies Record<keyof UserIdentity, keyof UserRow>;

const IDENTITY_SECRETS: (keyof UserIdentity)[] = ["bvnHash", "bvnEnc", "ninEnc", "ninHash"];

export type IdentityField = keyof UserIdentity;

export function toUser(row: UserRow, options: FindUserOptions = {}): User {
    const plain = stripNulls(row);
    const identity: Record<string, unknown> = { status: row.identityStatus };
    for (const [field, column] of Object.entries(IDENTITY_COLUMNS)) {
        delete plain[column];
        if (field === "status") continue;
        const value = row[column as keyof UserRow];
        if (value === null || value === undefined) continue;
        if (!options.withSecrets && IDENTITY_SECRETS.includes(field as IdentityField)) continue;
        identity[field] = value;
    }
    if (!options.withSecrets) {
        delete plain.password;
        delete plain.transactionPinHash;
    }
    const lockedUntil = row.transactionPinLockedUntil;
    return {
        ...plain,
        identity: identity as unknown as UserIdentity,
        isTransactionPinLocked: !!lockedUntil && lockedUntil.getTime() > Date.now(),
    };
}

/** The profile other records embed (populate), never secrets */
export function toPublicUser(user: User): PublicUser {
    return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phoneNumber: user.phoneNumber,
        whatsappNumber: user.whatsappNumber,
        role: user.role,
        status: user.status,
        tier: user.tier,
        isVerified: user.isVerified,
        isKYCDone: user.isKYCDone,
        isKYCRejected: user.isKYCRejected,
        countryOfOrigin: user.countryOfOrigin,
        countryOfResidence: user.countryOfResidence,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
}

function identityColumns(patch: Partial<Record<IdentityField, unknown>>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const column = IDENTITY_COLUMNS[field as IdentityField];
        if (!column) throw new Error(`Unknown identity field: ${field}`);
        out[column] = value;
    }
    return out;
}

export interface IdentityUpdateCondition {
    /** Only update while identity.status is this */
    statusIs?: IdentityStatus;
    /** Only update while identity.status is not this */
    statusIsNot?: IdentityStatus;
}

class UserRepository {
    async findById(id: string, options: FindUserOptions = {}, tx?: Executor): Promise<User | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec(tx).select().from(users).where(eq(users.id, id)).limit(1);
        return row ? toUser(row, options) : undefined;
    }

    /** Emails are matched case-insensitively (the unique index is on lower(email)) */
    async findByEmail(email: string, options: FindUserOptions = {}, tx?: Executor): Promise<User | undefined> {
        if (typeof email !== "string" || !email) return undefined;
        const [row] = await exec(tx).select().from(users).where(sql`lower(${users.email}) = lower(${email})`).limit(1);
        return row ? toUser(row, options) : undefined;
    }

    /** The authenticated user: the token's id and email must still match */
    async findByIdAndEmail(id: string, email: string): Promise<User | undefined> {
        if (!isUuid(id) || typeof email !== "string") return undefined;
        const [row] = await exec()
            .select()
            .from(users)
            .where(and(eq(users.id, id), sql`lower(${users.email}) = lower(${email})`))
            .limit(1);
        return row ? toUser(row) : undefined;
    }

    async findManyByIds(ids: string[], tx?: Executor): Promise<User[]> {
        const valid = [...new Set(ids.filter(isUuid))];
        if (!valid.length) return [];
        const rows = await exec(tx).select().from(users).where(inArray(users.id, valid));
        return rows.map((row) => toUser(row));
    }

    async create(data: NewUser, tx?: Executor): Promise<User> {
        const [row] = await exec(tx).insert(users).values(data).returning();
        return toUser(row);
    }

    /** Returns the updated user, or undefined if it doesn't exist */
    async update(id: string, patch: UserUpdate, tx?: Executor): Promise<User | undefined> {
        if (!isUuid(id)) return undefined;
        const values = definedOnly(patch as Record<string, unknown>);
        if (!Object.keys(values).length) return this.findById(id, {}, tx);
        const [row] = await exec(tx).update(users).set(values).where(eq(users.id, id)).returning();
        return row ? toUser(row) : undefined;
    }

    /**
     * Set / clear identity fields (`null` clears). Returns false when the
     * condition didn't match (nothing changed).
     */
    async updateIdentity(
        id: string,
        patch: Partial<{ [K in IdentityField]: UserIdentity[K] | null }>,
        condition: IdentityUpdateCondition = {},
        tx?: Executor
    ): Promise<boolean> {
        if (!isUuid(id)) return false;
        const values = identityColumns(patch);
        if (!Object.keys(values).length) return true;
        const where: SQL[] = [eq(users.id, id)];
        if (condition.statusIs) where.push(eq(users.identityStatus, condition.statusIs));
        if (condition.statusIsNot) where.push(ne(users.identityStatus, condition.statusIsNot));
        const rows = await exec(tx).update(users).set(values).where(and(...where)).returning({ id: users.id });
        return rows.length > 0;
    }

    /** Clears every identity field back to a fresh, unverified record */
    async resetIdentity(id: string, tx?: Executor): Promise<void> {
        const cleared: Record<string, unknown> = {};
        for (const [field, column] of Object.entries(IDENTITY_COLUMNS)) {
            cleared[column] = field === "status" ? "unverified" : null;
        }
        await exec(tx).update(users).set(cleared).where(eq(users.id, id));
    }

    /** Another account already holds this BVN / NIN hash */
    async identityHashInUse(field: "bvnHash" | "ninHash", hash: string, exceptUserId: string): Promise<boolean> {
        const column = field === "bvnHash" ? users.identityBvnHash : users.identityNinHash;
        const [row] = await exec()
            .select({ id: users.id })
            .from(users)
            .where(and(eq(column, hash), ne(users.id, exceptUserId)))
            .limit(1);
        return !!row;
    }

    /**
     * Move the user to `tier` and record why. With `onlyIfBelow` the change
     * only happens while their tier is lower (returns false otherwise).
     */
    async setTier(
        id: string,
        tier: UserTier,
        history: { reason: string; by?: string },
        options: { onlyIfBelow?: boolean; extra?: UserUpdate } = {},
        tx?: Executor
    ): Promise<boolean> {
        const run = async (db: Executor) => {
            const where = options.onlyIfBelow ? and(eq(users.id, id), lt(users.tier, tier)) : eq(users.id, id);
            const rows = await db
                .update(users)
                .set({ ...definedOnly((options.extra ?? {}) as Record<string, unknown>), tier })
                .where(where)
                .returning({ id: users.id });
            if (!rows.length) return false;
            await db.insert(userTierHistory).values({ user: id, tier, reason: history.reason, by: history.by });
            return true;
        };
        return tx ? run(tx) : exec().transaction(async (inner) => run(inner as unknown as Executor));
    }

    /** Newest first */
    async listTierHistory(userId: string): Promise<UserTierHistoryEntry[]> {
        const rows = await exec()
            .select()
            .from(userTierHistory)
            .where(eq(userTierHistory.user, userId))
            .orderBy(desc(userTierHistory.at), desc(userTierHistory.id));
        return rows.map(stripNulls);
    }

    /** Admin list, newest first */
    async listAll(limit = 300): Promise<User[]> {
        const rows = await exec().select().from(users).orderBy(desc(users.createdAt)).limit(limit);
        return rows.map((row) => toUser(row));
    }

    /** Ids of users whose email or name contains `term` (admin search) */
    async searchIds(term: string, limit = 200): Promise<string[]> {
        const pattern = `%${escapeLike(term)}%`;
        const rows = await exec()
            .select({ id: users.id })
            .from(users)
            .where(or(ilike(users.email, pattern), ilike(users.firstName, pattern), ilike(users.lastName, pattern)))
            .limit(limit);
        return rows.map((row) => row.id);
    }

    async count(filter: { isKYCDone?: boolean } = {}): Promise<number> {
        const where = filter.isKYCDone !== undefined ? eq(users.isKYCDone, filter.isKYCDone) : undefined;
        const [row] = await exec().select({ n: count() }).from(users).where(where);
        return Number(row?.n ?? 0);
    }

    /** Tokens issued before now stop working (sign out everywhere) */
    async endAllSessions(id: string, tx?: Executor): Promise<void> {
        if (!isUuid(id)) return;
        await exec(tx).update(users).set({ sessionsValidAfter: new Date() }).where(eq(users.id, id));
    }
}

export const userRepository = new UserRepository();
export default userRepository;
