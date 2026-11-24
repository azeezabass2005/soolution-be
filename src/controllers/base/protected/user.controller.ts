import BaseController from "../base-controller";
import {Request, Response, NextFunction} from "express";
import errorResponseMessage from "../../../common/messages/error-response-message";
import {ROLE_MAP} from "../../../common/constant";
import RoleMiddleware, { accessOf, allowed } from "../../../middlewares/role.middleware";
import { hasPermission, type Permission } from "../../../common/permissions";
import {userUpdateValidate} from "../../../validators";
import VerificationService from "../../../services/verification.service";
import { approvedBusinessName } from "../../../services/business-name.service";
import { USER_TIER } from "../../../common/tier.constants";
import rateLimit from "express-rate-limit";
import HashService from "../../../utils/hash.utils";
import UserService from "../../../services/user.service";
import NotificationService from "../../../utils/notification.utils";
import { passwordProblem } from "../../../common/password-policy";
import { clearAuthCookies } from "../../../utils/auth-cookies";
import { ErrorSeverity } from "../../../common/messages/error-response-message";
import logger from "../../../utils/logger.utils";
import adminUsersService from "../../../services/admin-users.service";
import userRepository from "../../../repositories/user.repository";
import { cleanCurrencyList } from "../../../common/operations";

/**
 * Controller handling authentication-related operations
 * @class UserController
 * @extends BaseController
 */
class UserController extends BaseController {

    verificationService: VerificationService;

    /**
     * Creates an instance of UserController
     */
    constructor() {
        super();
        this.setupRoutes();
        this.verificationService = new VerificationService();
    }

    /**
     * Sets up routes for authentication operations
     * @protected
     */
    protected setupRoutes(): void {
        // Get Current User route
        this.router.get("/current", this.getCurrentUser.bind(this));
        // Change password (needs the current one); signs out every device
        const changeLimiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 10,
            standardHeaders: true,
            legacyHeaders: false,
            message: { message: "Too many attempts. Please wait a few minutes and try again." },
        });
        this.router.post("/change-password", changeLimiter, this.changePassword.bind(this));
        // Get All Users route
        this.router.get("/", RoleMiddleware.can("users.directory", "users.stats"), this.getAllUsers.bind(this));
        // Update user route
        this.router.patch("/:id", RoleMiddleware.can("users.account_controls"), userUpdateValidate,  this.updateUser.bind(this));
        // One user's money, wallets, activity and possible repeat sign-ups
        this.router.get("/:id/overview", RoleMiddleware.can("users.directory"), this.getOverview.bind(this));
        // Suspend, freeze, or set a personal daily limit
        this.router.patch("/:id/controls", RoleMiddleware.can("users.account_controls", "users.daily_limit"), this.updateControls.bind(this));
        // Currencies turned off for one user (super admins: platform controls)
        this.router.put("/:id/currencies", RoleMiddleware.can("platform_controls"), this.setUserCurrencies.bind(this));
    }

    private async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { currentPassword, newPassword } = req.body || {};
            const fail = (path: string, message: string) => errorResponseMessage.createError(400, message, ErrorSeverity.LOW, { issues: [{ path, message }] });
            if (typeof currentPassword !== "string" || !currentPassword) return next(fail("currentPassword", "Enter your current password"));

            const userService = new UserService();
            const user = await userService.findById(res.locals.user.id, { withSecrets: true });
            if (!user?.password) return next(errorResponseMessage.unauthorized());
            if (!(await HashService.verifyPassword(currentPassword, user.password))) {
                return next(fail("currentPassword", "That isn't your current password"));
            }
            const problem = passwordProblem(newPassword, user);
            if (problem) return next(fail("newPassword", problem));
            if (await HashService.verifyPassword(newPassword, user.password)) {
                return next(fail("newPassword", "Choose a password you haven't been using"));
            }

            const hashed = await HashService.hashPassword(newPassword);
            await userService.update(user.id, { password: hashed.password });
            // Every session ends, this one too: the user signs in again with the new password
            await userService.endAllSessions(user.id);
            clearAuthCookies(res);
            logger.info("Password changed", { userId: user.id });

            new NotificationService().emailService.sendNotificationEmail(user.email, {
                name: user.firstName || "there",
                eyebrow: "Security",
                title: "Your password was changed",
                message: "Your Solution Pay password was just changed, and you've been signed out on every device. If this wasn't you, contact support@solutionpay.co straight away.",
            }).catch((error: any) => logger.warn("Password change notice failed", { error: error?.message }));

            return this.sendSuccess(res, { message: "Password changed. Sign in again with your new password." });
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Helper method to convert role number to role string
     * @private
     */
    private getRoleString(roleNumber: number): string {
        return Object.entries(ROLE_MAP).find(([_, v]) => v === roleNumber)?.[0] || 'Unknown';
    }

    /**
     * Retrieve the current user information.
     * @private
     */
    private async getCurrentUser(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = res.locals.user;

            if (!user) {
                return next(errorResponseMessage.unauthorized());
            }

            const { password, transactionPinHash, ...otherUserData } = user;

            const verificationData = await this.verificationService.latestForUser(user.id);

            const sanitizedUser = {
                ...otherUserData,
                role: this.getRoleString(user.role),
                /** Admins: super admin or staff, and what they can see and do (null for users) */
                access: user.role === ROLE_MAP.ADMIN ? await accessOf(res) : null,
                verificationData: verificationData ?? null,
                /** Shown instead of the person's name once a business account is approved */
                businessName: (user.tier >= USER_TIER.BUSINESS ? await approvedBusinessName(user.id) : undefined) ?? null,
            }
            
            return this.sendSuccess(res, {
                message: "User information retrieved successfully",
                user: sanitizedUser,
            })
        } catch (error) {
            return next(error)
        }
    }

    /**
     * Retrieve all users with role mapping
     * @private
     */
    private async getAllUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const access = await accessOf(res);
            const can = (p: Permission) => hasPermission(access, p);
            const users = await this.userService.listAll();
            // Money totals, latest KYC and possible repeat sign-ups, for the admin's columns
            const [stats, kyc] = await Promise.all([adminUsersService.moneyStats(), adminUsersService.kycStatuses()]);
            const seesIdentity = can("users.identity") || can("kyc");
            const heldNgn = Math.round([...stats.values()].reduce((sum, s) => sum + (s.balanceNgn || 0), 0) * 100) / 100;
            const duplicates = adminUsersService.duplicateIndex(users);
            const cleanUsers: any = []
            users.forEach(user => {
                if(user.email === "admin@solutionpay.co") return
                if(user.email === "test@gmail.com") return

                cleanUsers.push({
                    id: user.id,
                    email: user.email,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    isVerified: user.isVerified,
                    isCompleted: user.isCompleted,
                    tier: user.tier,
                    isKYCDone: user.isKYCDone,
                    isKYCRejected: user.isKYCRejected,
                    kycRejectionReason: user.kycRejectionReason,
                    status: user.status,
                    phoneNumber: user.phoneNumber,
                    whatsappNumber: user.whatsappNumber,
                    countryOfOrigin: user.countryOfOrigin,
                    countryOfResidence: user.countryOfResidence,
                    purpose: user.purpose,
                    typeOfBusiness: user.typeOfBusiness,
                    monthlyVolume: user.monthlyVolume,
                    hearAboutUs: user.hearAboutUs,
                    hearAboutUsOther: user.hearAboutUsOther,
                    createdAt: user.createdAt,
                    role: this.getRoleString(user.role),
                    freeze: user.freeze ?? "none",
                    identityStatus: user.identity?.status ?? "unverified",
                    hasProofOfAddress: !!user.identity?.proofOfAddress,
                    kyc: kyc.get(user.id) ?? null,
                    stats: stats.get(user.id) ?? null,
                    duplicateCount: duplicates.get(user.id)?.length ?? 0,
                    disabledCurrencies: user.disabledCurrencies ?? [],
                });
            });

            // Each admin gets only the columns their role covers
            const visible = cleanUsers.map((u: any) => {
                const row = { ...u };
                if (!seesIdentity) { delete row.identityStatus; delete row.hasProofOfAddress; row.kyc = null; delete row.kycRejectionReason; }
                if (!can("users.cards") && !can("users.balances")) row.stats = null;
                else if (row.stats && !can("users.balances")) row.stats = { ...row.stats, balanceNgn: null };
                else if (row.stats && !can("users.cards")) row.stats = { balanceNgn: row.stats.balanceNgn };
                if (!can("users.repeat_signups")) delete row.duplicateCount;
                if (!can("users.account_controls")) { delete row.freeze; }
                if (!can("platform_controls")) delete row.disabledCurrencies;
                return row;
            });

            return this.sendSuccess(res, {
                message: "All users retrieved successfully",
                // Without the directory, only the totals below
                users: can("users.directory") ? visible : [],
                summary: {
                    signedUp: cleanUsers.length,
                    identityVerified: cleanUsers.filter((u: any) => (u.tier ?? 0) >= 1 || u.isKYCDone).length,
                    awaitingUpgradeReview: [...kyc.values()].filter((k) => k.status === "submitted" || k.status === "under_review").length,
                    ...(can("users.stats") ? { heldNgn } : {}),
                },
            })
        } catch (error) {
            return next(error)
        }
    }

    private async getOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const overview = await adminUsersService.overview(String(req.params.id));
            return this.sendSuccess(res, await this.visibleOverview(overview, res));
        } catch (error) {
            return next(error);
        }
    }

    /** A user's overview with only the parts this admin may see (the rest are null) */
    private async visibleOverview(overview: Awaited<ReturnType<typeof adminUsersService.overview>>, res: Response) {
        const access = await accessOf(res);
        const can = (p: Permission) => hasPermission(access, p);
        const seesIdentity = can("users.identity") || can("kyc");
        const { identityStatus, hasProofOfAddress, freeze, freezeReason, dailyLimitOverrideNgn, ...user } = overview.user;
        return {
            user: {
                ...user,
                ...(seesIdentity ? { identityStatus, hasProofOfAddress } : {}),
                ...(can("users.account_controls") ? { freeze, freezeReason } : {}),
                ...(can("users.daily_limit") ? { dailyLimitOverrideNgn } : {}),
            },
            kyc: seesIdentity ? overview.kyc : null,
            stats: can("users.cards") ? (can("users.balances") ? overview.stats : { ...overview.stats, balanceNgn: null }) : null,
            wallets: can("users.balances") ? overview.wallets : null,
            duplicates: can("users.repeat_signups") ? overview.duplicates : null,
            transactions: can("users.transactions") ? overview.transactions : null,
            walletEntries: can("users.wallet_activity") ? overview.walletEntries : null,
        };
    }

    private async setUserCurrencies(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const target = await userRepository.findById(String(req.params.id));
            if (!target) return next(errorResponseMessage.resourceNotFound("User"));
            let off: string[];
            try {
                off = cleanCurrencyList(req.body?.off ?? []);
            } catch (error: any) {
                return next(errorResponseMessage.createError(400, error.message, ErrorSeverity.LOW));
            }
            await userRepository.update(target.id, { disabledCurrencies: off });
            logger.info("Admin changed a user's currencies", { adminId: res.locals.user?.id, userId: target.id, before: target.disabledCurrencies ?? [], after: off });
            return this.sendSuccess(res, { id: target.id, off, message: off.length ? `Turned off for this user: ${off.join(", ")}` : "Every currency is on for this user" });
        } catch (error) {
            return next(error);
        }
    }

    private async updateControls(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (String(req.params.id) === String(res.locals.user?.id) && req.body?.status === "suspended") {
                return next(errorResponseMessage.createError(400, "You can't suspend your own account.", ErrorSeverity.LOW));
            }
            // Suspend and freeze are account controls; a personal daily limit is its own permission
            const body = req.body ?? {};
            if ((body.status !== undefined || body.freeze !== undefined) && !(await allowed(res, "users.account_controls"))) {
                return next(errorResponseMessage.createError(403, "You can't change account controls", ErrorSeverity.HIGH));
            }
            if (body.dailyLimitOverrideNgn !== undefined && !(await allowed(res, "users.daily_limit"))) {
                return next(errorResponseMessage.createError(403, "You can't change daily limits", ErrorSeverity.HIGH));
            }
            await adminUsersService.updateControls(String(req.params.id), body, res.locals.user?.id);
            return this.sendSuccess(res, await this.visibleOverview(await adminUsersService.overview(String(req.params.id)), res));
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Updates the user
     * @private
     */
    private async updateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { status, role } = req.body;
            // Who's on the admin team is managed under Roles & staff (super admins only)
            if (role !== undefined && !(await accessOf(res)).superAdmin) {
                return next(errorResponseMessage.createError(403, "Only a super admin can change someone's role", ErrorSeverity.HIGH));
            }
            if (role !== undefined && String(req.params.id) === String(res.locals.user?.id)) {
                return next(errorResponseMessage.createError(400, "You can't change your own role", ErrorSeverity.LOW));
            }
            const user = await this.userService.update(req.params.id, {
                status,
                // Made an admin here = super admin; back to a user drops any staff role
                ...((role && role === "ADMIN") ? { role: ROLE_MAP.ADMIN, adminRoleId: null } : (role && role === "USER") ? { role: ROLE_MAP.USER, adminRoleId: null } : {}),
            });
            if(!user) {
                return next(errorResponseMessage.resourceNotFound("User not found"))
            }
            return this.sendSuccess(res, {
                user,
                message: "User updated successfully",
            })
        } catch (error) {
            return next(error)
        }
    }
}

export default new UserController().router;