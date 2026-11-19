import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { kycApplications, transactions, users, walletTransactions, wallets } from "../db/schema";
import { exec } from "../repositories/utils";
import userRepository from "../repositories/user.repository";
import UserService from "./user.service";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { USER_FREEZE_STATES, type UserFreeze } from "../db/schema/users";
import logger from "../utils/logger.utils";
import type { User } from "../types/entities";

const num = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;

/** Money totals for a user's naira wallet, from successful wallet entries */
export interface UserMoneyStats {
    /** Paid in by bank transfer to their account number */
    fundedNgn: number;
    /** From customers: payment links, GHS accounts, direct collections */
    receivedNgn: number;
    /** GHS top-ups they paid in themselves, as credited in naira, and the cedis paid */
    toppedUpNgn: number;
    toppedUpGhs: number;
    /** Sent abroad or to other banks from the wallet */
    sentNgn: number;
    withdrawnNgn: number;
    /** What's in the naira wallet now */
    balanceNgn: number;
}

export interface DuplicateMatch {
    userId: string;
    email: string;
    name: string;
    createdAt: Date;
    status: string;
    /** Why it looks like the same person */
    reasons: string[];
}

const EMPTY_STATS: UserMoneyStats = { fundedNgn: 0, receivedNgn: 0, toppedUpNgn: 0, toppedUpGhs: 0, sentNgn: 0, withdrawnNgn: 0, balanceNgn: 0 };

/** The last ten digits, so "+234 803…" and "0803…" match */
const phoneKey = (phone?: string | null) => {
    const digits = String(phone || "").replace(/\D/g, "");
    return digits.length >= 9 ? digits.slice(-10) : null;
};
const nameKey = (u: Pick<User, "firstName" | "lastName">) =>
    `${String(u.firstName || "").trim().toLowerCase()} ${String(u.lastName || "").trim().toLowerCase()}`.trim();

/**
 * What admins see about users: money totals for the list, a full overview
 * for one user, signs of the same person signing up again, and the
 * controls (suspend, freeze, a personal daily limit).
 */
class AdminUsersService {
    private userService = new UserService();

    /** Money totals for every user (or the ones given), keyed by user id */
    async moneyStats(userIds?: string[]): Promise<Map<string, UserMoneyStats>> {
        const wt = walletTransactions;
        const ngnOnly = sql`coalesce(${wt.currency}, 'NGN') = 'NGN'`;
        const onlyUsers = userIds?.length ? inArray(wt.user, userIds) : undefined;
        const sums = await exec()
            .select({
                user: wt.user,
                funded: sql<string>`coalesce(sum(case when ${wt.type} = 'funding' and ${wt.transactionId} is null then ${wt.amount} end), 0)`,
                received: sql<string>`coalesce(sum(case when ${wt.type} = 'funding' and ${wt.transactionId} is not null and coalesce(${transactions.purpose}, '') <> 'top_up' then ${wt.amount} end), 0)`,
                toppedUp: sql<string>`coalesce(sum(case when ${wt.type} = 'funding' and ${transactions.purpose} = 'top_up' then ${wt.amount} end), 0)`,
                sent: sql<string>`coalesce(sum(case when ${wt.type} = 'transfer' then ${wt.amount} end), 0)`,
                withdrawn: sql<string>`coalesce(sum(case when ${wt.type} = 'withdrawal' then ${wt.amount} end), 0)`,
            })
            .from(wt)
            .leftJoin(transactions, eq(transactions.id, wt.transactionId))
            .where(and(eq(wt.status, "successful"), ngnOnly, onlyUsers))
            .groupBy(wt.user);

        const topUps = await exec()
            .select({ user: transactions.user, ghs: sql<string>`coalesce(sum(${transactions.amount}), 0)` })
            .from(transactions)
            .where(and(eq(transactions.purpose, "top_up"), eq(transactions.status, "completed"), userIds?.length ? inArray(transactions.user, userIds) : undefined))
            .groupBy(transactions.user);

        const balances = await exec()
            .select({ user: wallets.user, balance: wallets.balance })
            .from(wallets)
            .where(and(eq(wallets.currency, "NGN"), userIds?.length ? inArray(wallets.user, userIds) : undefined));

        const out = new Map<string, UserMoneyStats>();
        const get = (id: string) => {
            if (!out.has(id)) out.set(id, { ...EMPTY_STATS });
            return out.get(id)!;
        };
        for (const r of sums) {
            Object.assign(get(r.user), { fundedNgn: num(r.funded), receivedNgn: num(r.received), toppedUpNgn: num(r.toppedUp), sentNgn: num(r.sent), withdrawnNgn: num(r.withdrawn) });
        }
        for (const r of topUps) get(r.user).toppedUpGhs = num(r.ghs);
        for (const r of balances) get(r.user).balanceNgn = num(r.balance);
        return out;
    }

    /** The latest KYC/KYB application status per user (drafts left out) */
    async kycStatuses(): Promise<Map<string, { status: string; type: string; tier: number }>> {
        const rows = await exec()
            .select({ user: kycApplications.user, status: kycApplications.status, type: kycApplications.type, tier: kycApplications.tier, updatedAt: kycApplications.updatedAt })
            .from(kycApplications)
            .orderBy(desc(kycApplications.updatedAt));
        const out = new Map<string, { status: string; type: string; tier: number }>();
        for (const r of rows) if (!out.has(r.user) && r.status !== "draft") out.set(r.user, { status: r.status, type: r.type, tier: r.tier });
        return out;
    }

    /**
     * Accounts that look like the same person: the same phone number, or the
     * same name with the same date of birth. For every user in `all`.
     */
    duplicateIndex(all: User[]): Map<string, DuplicateMatch[]> {
        const groups = new Map<string, User[]>();
        const add = (key: string | null, u: User) => {
            if (!key) return;
            groups.set(key, [...(groups.get(key) ?? []), u]);
        };
        for (const u of all) {
            add(phoneKey(u.phoneNumber) && `phone:${phoneKey(u.phoneNumber)}`, u);
            if (u.identity?.dob && nameKey(u)) add(`name-dob:${nameKey(u)}:${u.identity.dob}`, u);
        }
        const out = new Map<string, DuplicateMatch[]>();
        for (const [key, members] of groups) {
            if (members.length < 2) continue;
            const reason = key.startsWith("phone:") ? "Same phone number" : "Same name and date of birth";
            for (const u of members) {
                const list = out.get(u.id) ?? [];
                for (const other of members) {
                    if (other.id === u.id) continue;
                    const existing = list.find((m) => m.userId === other.id);
                    if (existing) { if (!existing.reasons.includes(reason)) existing.reasons.push(reason); continue; }
                    list.push({
                        userId: other.id,
                        email: other.email,
                        name: `${other.firstName ?? ""} ${other.lastName ?? ""}`.trim(),
                        createdAt: other.createdAt,
                        status: other.status,
                        reasons: [reason],
                    });
                }
                out.set(u.id, list);
            }
        }
        return out;
    }

    /** Everything about one user for the admin's user page */
    async overview(userId: string) {
        const user = await userRepository.findById(userId);
        if (!user) throw errorResponseMessage.resourceNotFound("User");
        const all = await this.userService.listAll();
        const [stats, kyc, userWallets, recent, walletEntries] = await Promise.all([
            this.moneyStats([userId]),
            this.kycStatuses(),
            exec().select().from(wallets).where(eq(wallets.user, userId)),
            exec().select().from(transactions).where(eq(transactions.user, userId)).orderBy(desc(transactions.createdAt)).limit(200),
            exec().select().from(walletTransactions).where(eq(walletTransactions.user, userId)).orderBy(desc(walletTransactions.createdAt)).limit(200),
        ]);
        return {
            user: {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                phoneNumber: user.phoneNumber,
                status: user.status,
                freeze: user.freeze ?? "none",
                freezeReason: user.freezeReason ?? null,
                dailyLimitOverrideNgn: user.dailyLimitOverrideNgn ?? null,
                tier: user.tier,
                isVerified: user.isVerified,
                identityStatus: user.identity?.status ?? "unverified",
                hasProofOfAddress: !!user.identity?.proofOfAddress,
                createdAt: user.createdAt,
                lastLogin: user.lastLogin ?? null,
            },
            kyc: kyc.get(userId) ?? null,
            stats: stats.get(userId) ?? { ...EMPTY_STATS },
            wallets: userWallets.map((w) => ({ id: w.id, currency: w.currency, balance: num(w.balance), status: w.status })),
            duplicates: this.duplicateIndex(all).get(userId) ?? [],
            transactions: recent,
            walletEntries,
        };
    }

    /**
     * An admin's change to a user's access: suspend (no sign-in; current
     * sessions end), freeze ("balance": nothing leaves; "account": nothing
     * moves), and a personal daily limit (null = back to the tier's).
     */
    async updateControls(userId: string, body: unknown, adminId: string) {
        const user = await userRepository.findById(userId);
        if (!user) throw errorResponseMessage.resourceNotFound("User");
        const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
        const bad = (message: string) => errorResponseMessage.createError(400, message, ErrorSeverity.LOW);
        const patch: Record<string, unknown> = {};

        if (b.status !== undefined) {
            if (!["active", "suspended"].includes(String(b.status))) throw bad("Status must be active or suspended");
            patch.status = b.status;
        }
        if (b.freeze !== undefined) {
            if (!(USER_FREEZE_STATES as readonly string[]).includes(String(b.freeze))) throw bad("Freeze must be none, balance or account");
            patch.freeze = b.freeze as UserFreeze;
            patch.freezeReason = b.freeze === "none" ? null : String(b.freezeReason ?? "").trim().slice(0, 300) || null;
        }
        if (b.dailyLimitOverrideNgn !== undefined) {
            if (b.dailyLimitOverrideNgn === null || b.dailyLimitOverrideNgn === "") patch.dailyLimitOverrideNgn = null;
            else {
                const n = Number(b.dailyLimitOverrideNgn);
                if (!(n >= 0) || n > 100_000_000_000) throw bad("Enter a daily limit in naira, or leave it empty to use the tier's");
                patch.dailyLimitOverrideNgn = Math.round(n * 100) / 100;
            }
        }
        if (!Object.keys(patch).length) throw bad("Nothing to change");

        const updated = await userRepository.update(userId, patch as any);
        // Suspending signs them out everywhere straight away
        if (patch.status === "suspended" && user.status !== "suspended") await this.userService.endAllSessions(userId);

        logger.info("Admin changed a user's access", { adminId, userId, before: { status: user.status, freeze: user.freeze, dailyLimitOverrideNgn: user.dailyLimitOverrideNgn }, change: patch });
        return updated;
    }
}

export default new AdminUsersService();
