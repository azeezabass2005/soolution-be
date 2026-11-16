import BaseController from "../base-controller";
import {Request, Response, NextFunction} from "express";
import errorResponseMessage from "../../../common/messages/error-response-message";
import {ROLE_MAP} from "../../../common/constant";
import RoleMiddleware from "../../../middlewares/role.middleware";
import {userUpdateValidate} from "../../../validators";
import VerificationService from "../../../services/verification.service";

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
        // Get All Users route
        this.router.get("/", RoleMiddleware.isAdmin, this.getAllUsers.bind(this));
        // Update user route
        this.router.patch("/:id", RoleMiddleware.isAdmin, userUpdateValidate,  this.updateUser.bind(this));
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
                verificationData: verificationData ?? null
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
                    role: this.getRoleString(user.role)
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