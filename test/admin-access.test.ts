import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";

const sentEmails = vi.hoisted(() => [] as Array<{ to: string; data: any }>);

vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        emailService = {
            sendNotificationEmail: vi.fn(async (to: string, data: any) => { sentEmails.push({ to, data }); }),
            sendWelcomeEmail: vi.fn(async () => undefined),
            verifyConnection: vi.fn(async () => true),
        };
        sendTransactionNotification = vi.fn();
        notifyAdmins = vi.fn();
        sendNotification = vi.fn();
        initializeWhatsApp = vi.fn();
    },
}));

import { startTestDatabase, stopTestDatabase } from "./helpers/db";
import { bootstrapLedger, createUser } from "./helpers/fixtures";
import App from "../src/app";
import TokenBuilder from "../src/utils/token.utils";
import { ROLE_MAP } from "../src/common/constant";
import adminAccessService from "../src/services/admin-access.service";
import userRepository from "../src/repositories/user.repository";

const tokenFor = (user: { id: string; email: string; role?: number }) =>
    new TokenBuilder().build().createToken(user as any, { expiresIn: "1h" } as any);

describe("admin roles and permissions", () => {
    let server: Server;
    let base: string;
    let superAdmin: { id: string; email: string };

    const call = async (method: string, path: string, user?: { id: string; email: string }, body?: unknown) => {
        const fresh = user ? await userRepository.findById(user.id) : undefined;
        const response = await fetch(`${base}/api/v1${path}`, {
            method,
            headers: { "content-type": "application/json", ...(fresh ? { authorization: `Bearer ${tokenFor(fresh)}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };

    /** A staff account with a new role holding `permissions` */
    const staffWith = async (name: string, permissions: string[]) => {
        const role = await adminAccessService.createRole({ name, permissions }, superAdmin.id);
        const user = await createUser({ email: `${name.toLowerCase().replace(/\W+/g, "-")}@example.test`, role: ROLE_MAP.ADMIN, adminRoleId: role.id } as any);
        return { user, role };
    };

    beforeAll(async () => {
        await startTestDatabase();
        await bootstrapLedger();
        superAdmin = await createUser({ email: "boss@example.test", role: ROLE_MAP.ADMIN } as any);
        const app = new App();
        server = app.app.listen(0);
        await new Promise((resolve) => server.once("listening", resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        await stopTestDatabase();
    });

    it("works out access: users none, admins without a role everything, staff their role's", async () => {
        const user = await createUser();
        expect((await adminAccessService.accessFor(user)).permissions).toEqual([]);
        const boss = await adminAccessService.accessFor(await userRepository.findById(superAdmin.id));
        expect(boss.superAdmin).toBe(true);
        expect(boss.permissions).toContain("profit_balances");

        // A role can't hold super-admin-only permissions, or made-up ones
        const { user: staff, role } = await staffWith("Support desk", ["support", "users.directory", "profit_balances", "roles", "nonsense"]);
        expect(role.permissions).toEqual(["users.directory", "support"]);
        const access = await adminAccessService.accessFor(staff);
        expect(access).toMatchObject({ superAdmin: false, role: { id: role.id, name: "Support desk" } });
        expect(access.permissions).toEqual(["users.directory", "support"]);
    });

    it("lets staff reach only what their role covers, and keeps everything else super admin only", async () => {
        const { user: cs } = await staffWith("Customer support", ["dashboard", "users.directory"]);
        // Allowed by the role
        expect((await call("GET", "/protected/dashboard", cs)).status).toBe(200);
        expect((await call("GET", "/protected/users", cs)).status).toBe(200);
        // Not in the role
        expect((await call("GET", "/protected/transactions/history-admin", cs)).status).toBe(403);
        expect((await call("GET", "/protected/admin/platform-settings", cs)).status).toBe(403);
        expect((await call("GET", "/protected/kyc", cs)).status).toBe(403);
        // Never for staff: technical pages, profit, roles
        expect((await call("GET", "/protected/admin/ledger/accounts", cs)).status).toBe(403);
        expect((await call("GET", "/protected/admin/insights/profit", cs)).status).toBe(403);
        expect((await call("GET", "/protected/admin/team/roles", cs)).status).toBe(403);
        // A normal user gets none of it
        const user = await createUser();
        expect((await call("GET", "/protected/dashboard", user)).status).toBe(403);
        // The super admin gets all of it
        expect((await call("GET", "/protected/admin/team/roles", superAdmin)).status).toBe(200);
        expect((await call("GET", "/protected/transactions/history-admin", superAdmin)).status).toBe(200);
    });

    it("hides the parts of a response a role doesn't cover", async () => {
        const { user: cs } = await staffWith("Front desk", ["dashboard", "users.directory"]);
        const customer = await createUser({ firstName: "Ifeoma" });

        // Dashboard: counts but no amounts or recent transactions
        const dash = await call("GET", "/protected/dashboard", cs);
        expect(dash.body.data.totalUsers).toBeGreaterThan(0);
        expect(dash.body.data.totalAmountCompleted).toBeUndefined();
        expect(dash.body.data.recentTransactions).toEqual([]);

        // A user's profile: only the base details
        const overview = (await call("GET", `/protected/users/${customer.id}/overview`, cs)).body.data;
        expect(overview.user.firstName).toBe("Ifeoma");
        expect(overview.user.identityStatus).toBeUndefined();
        expect(overview.user.freeze).toBeUndefined();
        expect(overview).toMatchObject({ kyc: null, stats: null, wallets: null, duplicates: null, transactions: null, walletEntries: null });

        // The directory: no money columns, no repeat sign-ups, no held-in-wallets total
        const list = (await call("GET", "/protected/users", cs)).body.data;
        const row = list.users.find((u: any) => u.id === customer.id);
        expect(row.stats).toBeNull();
        expect(row.duplicateCount).toBeUndefined();
        expect(list.summary.heldNgn).toBeUndefined();

        // Account controls and daily limits need their own permissions
        expect((await call("PATCH", `/protected/users/${customer.id}/controls`, cs, { status: "suspended" })).status).toBe(403);
        expect((await call("PATCH", `/protected/users/${customer.id}/controls`, cs, { dailyLimitOverrideNgn: 5 })).status).toBe(403);
        // Only a super admin changes who's an admin
        expect((await call("PATCH", `/protected/users/${customer.id}`, cs, { role: "ADMIN" })).status).toBe(403);
    });

    it("lets a role with transactions-in-a-profile see one user's transactions, not everyone's", async () => {
        const { user: viewer } = await staffWith("Profile viewer", ["users.directory", "users.transactions"]);
        const customer = await createUser();
        expect((await call("GET", `/protected/transactions/history-admin?user=${customer.id}`, viewer)).status).toBe(200);
        expect((await call("GET", "/protected/transactions/history-admin", viewer)).status).toBe(403);
    });

    it("checks each part of the platform settings against its own permission", async () => {
        const { user: pricing } = await staffWith("Pricing desk", ["pricing.daily_limits"]);
        expect((await call("GET", "/protected/admin/platform-settings", pricing)).status).toBe(200);
        expect((await call("PUT", "/protected/admin/platform-settings", pricing, { tierDailyLimitNgn: { tier1: 1_000_000 } })).status).toBe(200);
        expect((await call("PUT", "/protected/admin/platform-settings", pricing, { operations: { pause: { payments: true } } })).status).toBe(403);
        expect((await call("PUT", "/protected/admin/platform-settings", pricing, { operations: { manual: { open: "09:00" } } })).status).toBe(403);
    });

    it("applies a role change at once, and refuses to delete a role people still have", async () => {
        const { user: staff, role } = await staffWith("Compliance", ["dashboard"]);
        expect((await call("GET", "/protected/kyc", staff)).status).toBe(403);
        await adminAccessService.updateRole(role.id, { name: "Compliance", permissions: ["dashboard", "kyc"] }, superAdmin.id);
        expect((await call("GET", "/protected/kyc", staff)).status).toBe(200);

        await expect(adminAccessService.deleteRole(role.id, superAdmin.id)).rejects.toMatchObject({ response_code: 409 });
        await adminAccessService.removeFromTeam(staff.id, superAdmin.id);
        expect((await userRepository.findById(staff.id))).toMatchObject({ role: ROLE_MAP.USER });
        expect(await adminAccessService.deleteRole(role.id, superAdmin.id)).toEqual({ id: role.id });
    });

    it("never leaves the team without a super admin, and nobody changes their own access", async () => {
        await expect(adminAccessService.removeFromTeam(superAdmin.id, superAdmin.id)).rejects.toMatchObject({ response_code: 400 });
        const { role } = await staffWith("Treasury", ["dashboard"]);
        const second = await createUser({ email: "second-boss@example.test", role: ROLE_MAP.ADMIN } as any);
        // Two super admins: one can move the other to a role
        await adminAccessService.changeRole(second.id, { role: role.id }, superAdmin.id);
        expect((await adminAccessService.accessFor(await userRepository.findById(second.id))).superAdmin).toBe(false);
        // Back to one: the last super admin can't be demoted (by anyone)
        await expect(adminAccessService.changeRole(superAdmin.id, { role: role.id }, second.id)).rejects.toMatchObject({ response_code: 409 });
    });

    it("invites by email: the invited account joins with the role, nobody else can use the link", async () => {
        const { role } = await staffWith("Accountant", ["dashboard", "profit_balances"]);
        const invited = await createUser({ email: "new.hire@example.test" });
        const stranger = await createUser({ email: "someone.else@example.test" });

        const invite = await adminAccessService.invite({ email: "New.Hire@example.test", role: role.id }, superAdmin.id);
        expect(sentEmails.at(-1)).toMatchObject({ to: "new.hire@example.test", data: { buttonText: "Accept invitation" } });
        const token = invite.link.split("/admin-invite/")[1];

        // The public page shows the role and a masked email only
        const described = await call("GET", `/public/admin-invites/${token}`);
        expect(described.body.data).toMatchObject({ roleName: "Accountant", superAdmin: false });
        expect(described.body.data.email).toMatch(/^ne•+@example\.test$/);

        expect((await call("POST", `/protected/admin-invites/${token}/accept`, stranger)).status).toBe(403);
        const accepted = await call("POST", `/protected/admin-invites/${token}/accept`, invited);
        expect(accepted.status).toBe(200);
        const joined = await userRepository.findById(invited.id);
        expect(joined).toMatchObject({ role: ROLE_MAP.ADMIN, adminRoleId: role.id });
        // Used once only
        expect((await call("POST", `/protected/admin-invites/${token}/accept`, invited)).status).toBe(409);
        expect((await call("GET", `/public/admin-invites/not-a-real-token-at-all-xxxxxxxx`)).status).toBe(404);
    });

    it("tells the app what an admin can do on /users/current", async () => {
        const { user: staff } = await staffWith("Ops", ["dashboard", "transactions"]);
        const me = (await call("GET", "/protected/users/current", staff)).body.data.user;
        expect(me.access).toMatchObject({ superAdmin: false, permissions: ["dashboard", "transactions"], role: { name: "Ops" } });
        const boss = (await call("GET", "/protected/users/current", superAdmin)).body.data.user;
        expect(boss.access.superAdmin).toBe(true);
        const user = (await call("GET", "/protected/users/current", await createUser())).body.data.user;
        expect(user.access).toBeNull();
    });
});
