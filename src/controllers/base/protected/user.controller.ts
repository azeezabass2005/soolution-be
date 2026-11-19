import BaseController from "../base-controller";
import {Request, Response, NextFunction} from "express";
import errorResponseMessage from "../../../common/messages/error-response-message";
import {ROLE_MAP} from "../../../common/constant";
import RoleMiddleware from "../../../middlewares/role.middleware";
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
        this.router.get("/", RoleMiddleware.isAdmin, this.getAllUsers.bind(this));
        // Update user route
        this.router.patch("/:id", RoleMiddleware.isAdmin, userUpdateValidate,  this.updateUser.bind(this));
        // One user's money, wallets, activity and possible repeat sign-ups
        this.router.get("/:id/overview", RoleMiddleware.isAdmin, this.getOverview.bind(this));
        // Suspend, freeze, or set a personal daily limit
        this.router.patch("/:id/controls", RoleMiddleware.isAdmin, this.updateControls.bind(this));
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
            const users = await this.userService.listAll();
            // Money totals, latest KYC and possible repeat sign-ups, for the admin's columns
            const [stats, kyc] = await Promise.all([adminUsersService.moneyStats(), adminUsersService.kycStatuses()]);
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
                });
            });

            return this.sendSuccess(res, {
                message: "All users retrieved successfully",
                users: cleanUsers
            })
        } catch (error) {
            return next(error)
        }
    }

    private async getOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            return this.sendSuccess(res, await adminUsersService.overview(String(req.params.id)));
        } catch (error) {
            return next(error);
        }
    }

    private async updateControls(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (String(req.params.id) === String(res.locals.user?.id) && req.body?.status === "suspended") {
                return next(errorResponseMessage.createError(400, "You can't suspend your own account.", ErrorSeverity.LOW));
            }
            await adminUsersService.updateControls(String(req.params.id), req.body, res.locals.user?.id);
            return this.sendSuccess(res, await adminUsersService.overview(String(req.params.id)));
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
            const user = await this.userService.update(req.params.id, {
                status,
                ...((role && role === "ADMIN") ? { role: ROLE_MAP.ADMIN } : (role && role === "USER") ? { role: ROLE_MAP.USER } : {}),
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