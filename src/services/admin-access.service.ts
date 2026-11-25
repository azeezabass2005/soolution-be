import crypto from "crypto";
import { and, asc, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import z from "zod";
import { adminInvites, adminRoles, users } from "../db/schema";
import { exec } from "../repositories/utils";
import userRepository from "../repositories/user.repository";
import { ROLE_MAP } from "../common/constant";
import {
    GRANTABLE_PERMISSIONS, NO_ACCESS, PERMISSIONS, PERMISSION_KEYS,
    type AdminAccess, type Permission,
} from "../common/permissions";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import NotificationService from "../utils/notification.utils";
import config from "../config/env.config";
import logger from "../utils/logger.utils";
import AuditLogService from "./audit-log.service";
import HashService from "../utils/hash.utils";
import { passwordProblem } from "../common/password-policy";

const auditLog = new AuditLogService();
/** Who changed which access, kept in the audit log */
const record = (entry: { action: string; userId: string; beforeValue?: unknown; afterValue?: unknown }) =>
    auditLog.logAction(undefined, entry.userId, entry.action, entry.beforeValue, entry.afterValue).catch((error: any) => logger.warn("Audit log failed", { action: entry.action, error: error?.message }));

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROLE_CACHE_MS = 30_000;

type RoleRow = typeof adminRoles.$inferSelect;

const badRequest = (message: string, path?: string) =>
    errorResponseMessage.createError(400, message, ErrorSeverity.LOW, path ? { issues: [{ path, message }] } : undefined);
const conflict = (message: string) => errorResponseMessage.createError(409, message, ErrorSeverity.LOW);
const notFound = (what: string) => errorResponseMessage.resourceNotFound(what);

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** Only permissions a role may hold, each once, in the registry's order */
const cleanPermissions = (list: unknown): Permission[] => {
    const wanted = new Set(Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : []);
    return GRANTABLE_PERMISSIONS.filter((p) => wanted.has(p));
};

const ZRole = z.object({
    name: z.string({ required_error: "Name the role" }).trim().min(2, "Name the role").max(60, "Keep the name under 60 characters"),
    description: z.string().trim().max(240, "Keep the description under 240 characters").optional().transform((v) => v || undefined),
    permissions: z.array(z.string()).default([]),
});

const ZEmail = z.string({ required_error: "Enter an email address" }).trim().toLowerCase().email("Enter a valid email address");

/** Who they are on the team: super admin, or the id of their staff role */
const ZRoleChoice = z.union([z.literal("super_admin"), z.string().uuid("Choose a role")]);

const parse = <T>(schema: z.ZodType<T, any, any>, body: unknown): T => {
    const result = schema.safeParse(body ?? {});
    if (!result.success) {
        const issue = result.error.issues[0];
        throw badRequest(issue.message, issue.path.join("."));
    }
    return result.data;
};

/**
 * Who can do what in the admin panel, and managing that: roles, staff and
 * invitations. Every admin route asks `accessFor` (through RoleMiddleware).
 */
class AdminAccessService {
    private roleCache = new Map<string, { at: number; role: RoleRow | null }>();
    private notifications = new NotificationService();

    // ─────────────── Access ───────────────

    private async loadRole(id: string): Promise<RoleRow | null> {
        const cached = this.roleCache.get(id);
        if (cached && Date.now() - cached.at < ROLE_CACHE_MS) return cached.role;
        const [role] = await exec().select().from(adminRoles).where(eq(adminRoles.id, id)).limit(1);
        this.roleCache.set(id, { at: Date.now(), role: role ?? null });
        return role ?? null;
    }

    /**
     * What this account can do in the admin panel. Not an admin: nothing. An
     * admin with no staff role: super admin, everything. Staff: their role's
     * permissions (none if the role can't be found, never everything).
     */
    async accessFor(user: { role?: number; adminRoleId?: string | null } | null | undefined): Promise<AdminAccess> {
        if (!user || user.role !== ROLE_MAP.ADMIN) return NO_ACCESS;
        if (!user.adminRoleId) return { superAdmin: true, permissions: [...PERMISSION_KEYS], role: null };
        const role = await this.loadRole(user.adminRoleId);
        if (!role) return { superAdmin: false, permissions: [], role: null };
        return { superAdmin: false, permissions: cleanPermissions(role.permissions), role: { id: role.id, name: role.name } };
    }

    /**
     * Ids of everyone on the team who holds a permission (all super admins,
     * and staff whose role includes it), active accounts only.
     */
    async teamWith(permission: Permission): Promise<string[]> {
        const rows = await exec()
            .select({ id: users.id, roleId: users.adminRoleId, permissions: adminRoles.permissions })
            .from(users)
            .leftJoin(adminRoles, eq(adminRoles.id, users.adminRoleId))
            .where(and(eq(users.role, ROLE_MAP.ADMIN), eq(users.status, "active")));
        return rows.filter((r) => !r.roleId || cleanPermissions(r.permissions).includes(permission)).map((r) => r.id);
    }

    // ─────────────── Roles ───────────────

    /** Every role with how many staff have it */
    async listRoles() {
        const [roles, members] = await Promise.all([
            exec().select().from(adminRoles).orderBy(asc(adminRoles.name)),
            exec().select({ roleId: users.adminRoleId, n: count() }).from(users).where(eq(users.role, ROLE_MAP.ADMIN)).groupBy(users.adminRoleId),
        ]);
        const byRole = new Map(members.map((m) => [m.roleId, Number(m.n)]));
        return roles.map((r) => ({ id: r.id, name: r.name, description: r.description ?? null, permissions: cleanPermissions(r.permissions), members: byRole.get(r.id) ?? 0, createdAt: r.createdAt }));
    }

    /** The permission list the role editor shows */
    permissionCatalog() {
        return PERMISSIONS.map((p) => ({ ...p, superAdminOnly: "superAdminOnly" in p ? !!p.superAdminOnly : false }));
    }

    async createRole(body: unknown, by: string) {
        const data = parse(ZRole, body);
        await this.assertNameFree(data.name);
        const [role] = await exec().insert(adminRoles).values({ name: data.name, description: data.description, permissions: cleanPermissions(data.permissions), createdBy: by }).returning();
        await record({ action: "admin_role.created", userId: by, afterValue: { id: role.id, name: role.name, permissions: role.permissions } });
        return role;
    }

    async updateRole(id: string, body: unknown, by: string) {
        const existing = await this.findRole(id);
        const data = parse(ZRole, body);
        if (data.name.toLowerCase() !== existing.name.toLowerCase()) await this.assertNameFree(data.name);
        const [role] = await exec().update(adminRoles)
            .set({ name: data.name, description: data.description ?? null, permissions: cleanPermissions(data.permissions) })
            .where(eq(adminRoles.id, id)).returning();
        this.roleCache.delete(id);
        await record({ action: "admin_role.updated", userId: by, beforeValue: { name: existing.name, permissions: existing.permissions }, afterValue: { name: role.name, permissions: role.permissions } });
        return role;
    }

    /** Refused while anyone has the role: they'd otherwise lose (or worse, gain) access silently */
    async deleteRole(id: string, by: string) {
        const role = await this.findRole(id);
        const [{ n }] = await exec().select({ n: count() }).from(users).where(eq(users.adminRoleId, id));
        if (Number(n) > 0) throw conflict(`${Number(n)} ${Number(n) === 1 ? "person has" : "people have"} this role. Move them to another role first.`);
        await exec().delete(adminRoles).where(eq(adminRoles.id, id));
        this.roleCache.delete(id);
        await record({ action: "admin_role.deleted", userId: by, beforeValue: { id, name: role.name, permissions: role.permissions } });
        return { id };
    }

    private async findRole(id: string): Promise<RoleRow> {
        if (!z.string().uuid().safeParse(id).success) throw notFound("Role");
        const [role] = await exec().select().from(adminRoles).where(eq(adminRoles.id, id)).limit(1);
        if (!role) throw notFound("Role");
        return role;
    }

    private async assertNameFree(name: string) {
        const [taken] = await exec().select({ id: adminRoles.id }).from(adminRoles).where(sql`lower(${adminRoles.name}) = lower(${name})`).limit(1);
        if (taken) throw conflict(`There's already a role called "${name}".`);
    }

    // ─────────────── Staff ───────────────

    /** Everyone on the admin team, super admins first */
    async listStaff() {
        const rows = await exec()
            .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName, roleId: users.adminRoleId, roleName: adminRoles.name, lastLogin: users.lastLogin, status: users.status })
            .from(users)
            .leftJoin(adminRoles, eq(adminRoles.id, users.adminRoleId))
            .where(eq(users.role, ROLE_MAP.ADMIN))
            .orderBy(sql`${users.adminRoleId} is not null`, asc(users.firstName));
        return rows.map((r) => ({ ...r, superAdmin: !r.roleId }));
    }

    private async superAdminCount() {
        const [{ n }] = await exec().select({ n: count() }).from(users).where(and(eq(users.role, ROLE_MAP.ADMIN), isNull(users.adminRoleId), eq(users.status, "active")));
        return Number(n);
    }

    /**
     * Puts an existing account on the team (or moves them): as super admin, or
     * with a role. Their sessions end so their new access applies straight away.
     */
    async assign(body: unknown, by: string) {
        const data = parse(z.object({ email: ZEmail, role: ZRoleChoice }), body);
        const user = await userRepository.findByEmail(data.email);
        if (!user) throw notFound("An account with that email. Invite them instead");
        return this.setTeamRole(user.id, data.role, by);
    }

    /** Changes a team member's role (or makes them super admin) */
    async changeRole(userId: string, body: unknown, by: string) {
        const data = parse(z.object({ role: ZRoleChoice }), body);
        const user = await userRepository.findById(userId);
        if (!user || user.role !== ROLE_MAP.ADMIN) throw notFound("Team member");
        return this.setTeamRole(user.id, data.role, by);
    }

    private async setTeamRole(userId: string, choice: string, by: string) {
        const user = await userRepository.findById(userId);
        if (!user) throw notFound("Account");
        if (userId === by) throw badRequest("You can't change your own access. Ask another super admin.");
        const roleId = choice === "super_admin" ? null : (await this.findRole(choice)).id;
        const wasSuper = user.role === ROLE_MAP.ADMIN && !user.adminRoleId;
        if (wasSuper && roleId && (await this.superAdminCount()) <= 1) throw conflict("They're the only super admin. Make someone else a super admin first.");
        await userRepository.update(userId, { role: ROLE_MAP.ADMIN, adminRoleId: roleId });
        await userRepository.endAllSessions(userId);
        await record({
            action: "admin_staff.role_set", userId: by,
            beforeValue: { user: userId, role: user.role, adminRoleId: user.adminRoleId ?? null },
            afterValue: { user: userId, role: ROLE_MAP.ADMIN, adminRoleId: roleId },
        });
        return { id: userId, superAdmin: !roleId, roleId };
    }

    /** Takes someone off the team: their account becomes a normal user account */
    async removeFromTeam(userId: string, by: string) {
        const user = await userRepository.findById(userId);
        if (!user || user.role !== ROLE_MAP.ADMIN) throw notFound("Team member");
        if (userId === by) throw badRequest("You can't remove yourself from the team.");
        if (!user.adminRoleId && (await this.superAdminCount()) <= 1) throw conflict("They're the only super admin. Make someone else a super admin first.");
        await userRepository.update(userId, { role: ROLE_MAP.USER, adminRoleId: null });
        await userRepository.endAllSessions(userId);
        await record({ action: "admin_staff.removed", userId: by, beforeValue: { user: userId, adminRoleId: user.adminRoleId ?? null } });
        return { id: userId };
    }

    // ─────────────── Invitations ───────────────

    async listInvites() {
        const rows = await exec()
            .select({ id: adminInvites.id, email: adminInvites.email, roleId: adminInvites.roleId, roleName: adminRoles.name, expiresAt: adminInvites.expiresAt, createdAt: adminInvites.createdAt })
            .from(adminInvites)
            .leftJoin(adminRoles, eq(adminRoles.id, adminInvites.roleId))
            .where(and(isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt), gt(adminInvites.expiresAt, new Date())))
            .orderBy(desc(adminInvites.createdAt));
        return rows.map((r) => ({ ...r, superAdmin: !r.roleId }));
    }

    /**
     * Emails a link to join the team. A newer invite for the same email replaces
     * any still open. Returns the link too, so it can be shared another way.
     */
    async invite(body: unknown, by: string) {
        const data = parse(z.object({ email: ZEmail, role: ZRoleChoice }), body);
        const role = data.role === "super_admin" ? null : await this.findRole(data.role);
        const existing = await userRepository.findByEmail(data.email);
        if (existing?.role === ROLE_MAP.ADMIN) throw conflict("They're already on the team. Change their role instead.");
        const inviter = await userRepository.findById(by);

        const token = crypto.randomBytes(32).toString("base64url");
        await exec().update(adminInvites).set({ revokedAt: new Date() })
            .where(and(sql`lower(${adminInvites.email}) = ${data.email}`, isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt)));
        const [invite] = await exec().insert(adminInvites).values({
            email: data.email, roleId: role?.id ?? null, tokenHash: hashToken(token), invitedBy: by, expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        }).returning();
        const link = `${config.FRONTEND_URL}/admin-invite/${token}`;
        const as = role ? `the ${role.name} role` : "a super admin";
        this.notifications.emailService.sendNotificationEmail(data.email, {
            name: existing?.firstName || "there",
            eyebrow: "Team invitation",
            title: "You're invited to the Solution Pay admin team",
            message: `${inviter ? `${inviter.firstName} ${inviter.lastName}`.trim() : "A super admin"} invited you to join as ${as}. ${existing ? "Open the link, sign in with this email, then accept." : "Open the link to set your name and password; your team account is ready straight away."} The invitation expires in 7 days. If you didn't expect this, ignore this email.`,
            actionUrl: link,
            buttonText: "Accept invitation",
        }).catch((error: any) => logger.warn("Admin invite email failed", { error: error?.message }));
        await record({ action: "admin_invite.sent", userId: by, afterValue: { email: data.email, roleId: role?.id ?? null } });
        return { id: invite.id, email: invite.email, superAdmin: !role, roleName: role?.name ?? null, expiresAt: invite.expiresAt, link };
    }

    async revokeInvite(id: string, by: string) {
        if (!z.string().uuid().safeParse(id).success) throw notFound("Invitation");
        const [row] = await exec().update(adminInvites).set({ revokedAt: new Date() })
            .where(and(eq(adminInvites.id, id), isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt))).returning();
        if (!row) throw notFound("Invitation");
        await record({ action: "admin_invite.revoked", userId: by, beforeValue: { email: row.email } });
        return { id };
    }

    private async openInvite(token: string) {
        if (typeof token !== "string" || token.length < 20 || token.length > 100) throw notFound("Invitation");
        const [row] = await exec()
            .select({ invite: adminInvites, roleName: adminRoles.name })
            .from(adminInvites)
            .leftJoin(adminRoles, eq(adminRoles.id, adminInvites.roleId))
            .where(eq(adminInvites.tokenHash, hashToken(token)))
            .limit(1);
        if (!row || row.invite.revokedAt) throw notFound("Invitation");
        if (row.invite.acceptedAt) throw conflict("This invitation has already been used.");
        if (row.invite.expiresAt.getTime() < Date.now()) throw conflict("This invitation has expired. Ask for a new one.");
        return row;
    }

    /** What the invitation page shows before signing in: who it's for and as what */
    async describeInvite(token: string) {
        const { invite, roleName } = await this.openInvite(token);
        const [local, domain] = invite.email.split("@");
        return {
            email: `${local.slice(0, 2)}${"•".repeat(Math.max(1, local.length - 2))}@${domain}`,
            superAdmin: !invite.roleId,
            roleName: roleName ?? null,
            expiresAt: invite.expiresAt,
        };
    }

    /**
     * Someone invited with no account creates one from the invitation: the link
     * reached their inbox, so the email is proven and there's no customer
     * onboarding. The account is a team account with the invited role, and the
     * invitation is used up. They sign in next (with the usual email code).
     */
    async registerFromInvite(token: string, body: unknown) {
        const { invite } = await this.openInvite(token);
        const data = parse(z.object({
            firstName: z.string().trim().min(2, "Enter your first name").max(60),
            lastName: z.string().trim().min(2, "Enter your last name").max(60),
            password: z.string({ required_error: "Choose a password" }).max(200),
        }), body);
        const problem = passwordProblem(data.password, { ...data, email: invite.email });
        if (problem) throw errorResponseMessage.createError(400, problem, ErrorSeverity.LOW, { issues: [{ path: "password", message: problem }] });
        if (await userRepository.findByEmail(invite.email)) throw conflict("An account already uses this email. Sign in to accept the invitation.");
        if (invite.roleId) await this.findRole(invite.roleId);

        const hashed = await HashService.hashPassword(data.password);
        const user = await exec().transaction(async (tx) => {
            const [claimed] = await exec(tx).update(adminInvites).set({ acceptedAt: new Date() })
                .where(and(eq(adminInvites.id, invite.id), isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt))).returning();
            if (!claimed) throw conflict("This invitation has already been used.");
            const created = await userRepository.create({
                email: invite.email,
                firstName: data.firstName,
                lastName: data.lastName,
                password: hashed.password,
                isVerified: true,
                isCompleted: true,
                role: ROLE_MAP.ADMIN,
                adminRoleId: invite.roleId ?? null,
            } as any, tx);
            await exec(tx).update(adminInvites).set({ acceptedBy: created.id }).where(eq(adminInvites.id, invite.id));
            return created;
        });
        await record({ action: "admin_invite.accepted", userId: user.id, afterValue: { inviteId: invite.id, adminRoleId: invite.roleId ?? null, newAccount: true } });
        logger.info("Team account created from an invitation", { userId: user.id, inviteId: invite.id });
        return { email: invite.email, superAdmin: !invite.roleId };
    }

    /** The signed-in account joins the team, if it's the invited email */
    async acceptInvite(token: string, userId: string) {
        const { invite } = await this.openInvite(token);
        const user = await userRepository.findById(userId);
        if (!user) throw errorResponseMessage.unauthorized();
        if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
            throw errorResponseMessage.createError(403, "This invitation is for a different email. Sign in with the email it was sent to.", ErrorSeverity.LOW);
        }
        if (user.role === ROLE_MAP.ADMIN) throw conflict("You're already on the team.");
        if (invite.roleId) await this.findRole(invite.roleId);
        const [claimed] = await exec().update(adminInvites).set({ acceptedAt: new Date(), acceptedBy: userId })
            .where(and(eq(adminInvites.id, invite.id), isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt))).returning();
        if (!claimed) throw conflict("This invitation has already been used.");
        await userRepository.update(userId, { role: ROLE_MAP.ADMIN, adminRoleId: invite.roleId ?? null });
        await userRepository.endAllSessions(userId);
        await record({ action: "admin_invite.accepted", userId, afterValue: { inviteId: invite.id, adminRoleId: invite.roleId ?? null } });
        return { superAdmin: !invite.roleId };
    }
}

export default new AdminAccessService();
