import {NextFunction, Request, Response} from "express";
import BaseController from "../base-controller";
import HashService from "../../../utils/hash.utils";
import TokenBuilder, {TokenUtils} from "../../../utils/token.utils";
import errorResponseMessage, {ErrorResponseCode, ErrorSeverity} from "../../../common/messages/error-response-message";
import {IRefreshTokenPayload, TokenType} from "../../../utils/interface";
import {ROLE_MAP} from "../../../common/constant";
import RefreshTokenService from "../../../services/refresh.service";
import authMiddleware from "../../../middlewares/auth.middleware";
import {loginValidate, postRegisterValidate, registerValidate, validateResetTransactionPin} from "../../../validators";
import {IUser} from "../../../models/interface";
import config from "../../../config/env.config";
import NotificationService from "../../../utils/notification.utils";
import PinService from "../../../services/pin.service";

/**
 * Controller handling authentication-related operations
 * @class AuthController
 * @extends BaseController
 */
class AuthController extends BaseController {
    private tokenBuilder: TokenBuilder;
    private refreshTokenService: RefreshTokenService;
    private notificationService: NotificationService;
    private pinService: PinService;

    /**
     * Creates an instance of AuthController
     */
    constructor() {
        super();
        this.tokenBuilder = new TokenBuilder();
        this.refreshTokenService = new RefreshTokenService;
        this.notificationService = new NotificationService();
        this.pinService = new PinService();
        this.setupRoutes();
    }

    /**
     * Sets up routes for authentication operations
     * @protected
     */
    protected setupRoutes(): void {
        // Registration route
        this.router.post("/register", registerValidate, this.register.bind(this));

        // Complete Registration route
        this.router.patch("/complete-registration", postRegisterValidate, this.completeRegistration.bind(this))

        // Login route
        this.router.post("/login", loginValidate, this.login.bind(this));

        // Verify email route
        this.router.post("/verify-email", this.verifyEmail.bind(this));

        // Request password reset route
        this.router.post("/forgot-password", this.forgotPassword.bind(this));

        // Reset password route
        this.router.post("/reset-password", this.resetPassword.bind(this));

        // Reset transaction PIN via emailed token
        this.router.post("/reset-pin", validateResetTransactionPin, this.resetPin.bind(this));

        // Refresh token route
        this.router.post("/refresh-token", this.refreshToken.bind(this));

        // Logout route
        // You can choose to migrate this to the protected route section for the auth.
        this.router.post("/logout-all",
            authMiddleware.validateAuthorization.bind(authMiddleware),
            this.logoutAll.bind(this)
        );
    }

    /**
     * Registers a new user
     * @private
     */
    private async register (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { email, password, firstName, lastName } = req.body;

            // Check if user already exists
            const existingUser = await this.userService.findOne({
                email: email
            });

            console.log(existingUser, "This is the existing user")

            if (existingUser) {
                return next(errorResponseMessage.createError(
                    ErrorResponseCode.RESOURCE_ALREADY_EXISTS,
                    "Email already exists",
                    ErrorSeverity.MEDIUM
                ));
            }

            // Hash password
            const hashedPassword = await HashService.hashPassword(password);

            // Create user
            const user = await this.userService.save({
                email,
                firstName,
                lastName,
                password: hashedPassword.password,
                isVerified: false
            });

            // Generate verification token
            // const verificationToken = this.tokenBuilder.build().createVerifyToken({
            //     userId: user._id as string,
            //     email: user.email,
            //     username: user.username
            // });

            // Send welcome email to newly registered user
            try {
                await this.notificationService.emailService.sendWelcomeEmail(
                    user.email,
                    {
                        name: `${user.firstName} ${user.lastName}`,
                        appName: 'Solution Pay',
                        actionUrl: `${config.FRONTEND_URL}/dashboard/user`,
                        buttonText: 'Get Started'
                    }
                );
                this.logger.info('Welcome email sent successfully', {
                    userId: user._id,
                    email: user.email,
                    name: `${user.firstName} ${user.lastName}`
                });
            } catch (error) {
                this.logger.error('Failed to send welcome email during registration', {
                    userId: user._id,
                    email: user.email,
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                });
                // Don't fail registration if email fails - user account is already created
            }

            this.sendSuccess(res, {
                message: "Registration successful. Please verify your email.",
                userId: user._id
            }, 201);
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Complete user registration
     * @private
     */
    private async completeRegistration (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { userId } = req.query;
            if(!userId) {
                return next(errorResponseMessage.createError(
                    ErrorResponseCode.BAD_REQUEST,
                    "User Id is required to complete registration",
                    ErrorSeverity.HIGH
                ))
            }

            const userExists = await this.userService.findById(userId as string);

            if(!userExists) {
                return next(errorResponseMessage.createError(
                    ErrorResponseCode.NOT_FOUND,
                    "User not found",
                    ErrorSeverity.HIGH
                ))
            }

            const registrationCompleteionData: Partial<IUser> = req.body;

            const completeUser = await this.userService.updateById(userId as string, {...registrationCompleteionData, isCompleted: true})

            if(!completeUser) {
                throw new Error("Failed to complete user registration");
            }

            // Sign the new user in (a persistent session, as before)
            const { accessToken, refreshToken } = await this.issueSession(req, res, completeUser, true);

            // Update last login timestamp
            await this.userService.updateById(completeUser._id as string, {
                lastLogin: new Date()
            });

            this.sendSuccess(res, {
                accessToken,
                refreshToken,
                message: "Registration completed successfully. You are now logged in.",
                user: {
                    id: completeUser._id,
                    email: completeUser.email,
                    role: Object.entries(ROLE_MAP).find(([_, v]) => v === completeUser.role)?.[0]
                }
            })
        } catch(error) {
            return next(error)
        }
    }

    /**
     * Authenticates a user and returns access token
     * @private
     */
    private async login (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { email, password } = req.body;
            // "Keep me signed in" — otherwise the session ends when the browser closes
            const rememberMe = req.body?.rememberMe === true;

            if (!email || !password) {
                return next(errorResponseMessage.payloadIncorrect("Email and password are required"));
            }

            const user = await this.userService.findOne({ email }, { select: ['+password'] });
            if (!user) {
                return next(errorResponseMessage.unauthorized("Invalid credentials"));
            }

            if (user.status !== 'active') {
                return next(errorResponseMessage.unauthorized(`Login failed because your account has been ${user.status}. Reach out to support@solutionpay.co for further info`));
            }

            const isValidPassword = await HashService.verifyPassword(
                password,
                user.password
            );

            if (!isValidPassword) {
                return next(errorResponseMessage.unauthorized("Invalid credentials"));
            }

            if(!user?.isCompleted && user?.role !== ROLE_MAP.ADMIN) {
                return this.sendSuccess(res, {
                    message: "Registration not completed. Redirecting to completion step",
                    not_completed: true,
                    userId: user._id
                });
            }

            // Temporarily removed email verification check for login
            // if (!user.isVerified) {
            //     next(errorResponseMessage.unauthorized("Please verify your email first"));
            //     return;
            // }

            const { accessToken, refreshToken } = await this.issueSession(req, res, user, rememberMe);

            // Update last login timestamp
            await this.userService.updateById(user._id as string, {
                lastLogin: new Date()
            });

            // Send login notification email to user
            try {
                await this.notificationService.emailService.sendNotificationEmail(
                    user.email,
                    {
                        title: '🔐 Login Successful',
                        message: `Hello ${user.firstName}, you have successfully logged into your Solution Pay account. If this wasn't you, please contact support immediately.`,
                        appName: 'Solution Pay',
                        actionUrl: `${config.FRONTEND_URL}/dashboard/user`,
                        buttonText: 'Go to Dashboard'
                    }
                );
                this.logger.info('Login notification email sent successfully', {
                    userId: user._id,
                    email: user.email,
                    name: `${user.firstName} ${user.lastName}`,
                    ip: req.ip,
                    userAgent: req.headers['user-agent']
                });
            } catch (error) {
                this.logger.error('Failed to send login notification email', {
                    userId: user._id,
                    email: user.email,
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    ip: req.ip
                });
                // Don't fail login if email fails - authentication is already successful
            }

            this.sendSuccess(res, {
                accessToken,
                refreshToken,
                message: "You are successfully logged in.",
                user: {
                    id: user._id,
                    email: user.email,
                    role: Object.entries(ROLE_MAP).find(([_, v]) => v === user.role)?.[0]
                }
            });
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Verifies user's email address
     * @private
     */
    private async verifyEmail (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { token } = req.body;

            if (!token) {
                return next(errorResponseMessage.payloadIncorrect("Verification token is required"));
            }

            // Verify token
            const decoded = await this.tokenBuilder
                .setToken(token)
                .build()
                .verifyToken();

            if (decoded.type !== TokenType.VERIFY) {
                return next(errorResponseMessage.unauthorized("Invalid verification token"));
            }

            // Update user verification status
            const user = await this.userService.updateById(decoded.data.userId, {
                isVerified: true
            });

            if (!user) {
                return next(errorResponseMessage.resourceNotFound("User"));
            }

            this.sendSuccess(res, {
                message: "Email verified successfully"
            });
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Initiates password reset process
     * @private
     */
    private async forgotPassword (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { email } = req.body;

            if (!email) {
                return next(errorResponseMessage.payloadIncorrect("Email is required"));
            }

            const user = await this.userService.findOne({ email });

            // Always return success even if user doesn't exist (security best practice)
            this.sendSuccess(res, {
                message: "If your email exists, you will receive a password reset link"
            });

            if (user) {
                // Generate reset token
                // const resetToken = this.tokenBuilder.build().createToken(user, {
                //     type: TokenType.RESET,
                //     expiresIn: '1h'
                // });

                // TODO: Send password reset email
                // await emailService.sendPasswordResetEmail(email, resetToken);
            }
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Resets user's password
     * @private
     */
    private async resetPassword (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { token, newPassword } = req.body;

            if (!token || !newPassword) {
                return next(errorResponseMessage.payloadIncorrect("Token and new password are required"));
            }

            // Verify token
            const decoded = await this.tokenBuilder
                .setToken(token)
                .build()
                .verifyToken();

            if (decoded.type !== TokenType.RESET) {
                return next(errorResponseMessage.unauthorized("Invalid reset token"));
            }

            // Hash new password
            const hashedPassword = await HashService.hashPassword(newPassword);

            // Update password
            const user = await this.userService.updateById(decoded.data.userId, {
                password: hashedPassword.password
            });

            if (!user) {
                return next(errorResponseMessage.resourceNotFound("User"));
            }

            this.sendSuccess(res, {
                message: "Password reset successful"
            });
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Resets the user's 4-digit transaction PIN using a token from the
     * forgot-PIN email link. The PinService validates the token type and
     * expiry; on success the user can immediately authorize transactions
     * with the new PIN.
     */
    private async resetPin (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { token, newPin } = req.body;
            await this.pinService.resetWithToken(token, newPin);
            this.sendSuccess(res, { message: "Transaction PIN reset successful" });
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Refreshes access token using refresh token
     * @private
     */
    private async refreshToken (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {


            if (!req.headers?.cookie) {
                return next(errorResponseMessage.payloadIncorrect("Refresh token is required"));
            }

            const cookies = req.headers.cookie.split(';').map(cookie => cookie.trim());

            let refreshToken = undefined;
            for (const cookie of cookies) {
                const equalIndex = cookie.indexOf('=');
                if (equalIndex === -1) continue;
                const name = cookie.substring(0, equalIndex).trim();
                const value = cookie.substring(equalIndex + 1).trim();
                if (name === 'refreshToken') {
                    refreshToken = value;
                    break;
                }
            }

            if (!refreshToken) {
                return next(errorResponseMessage.payloadIncorrect("Refresh token is required"));
            }

            // Verify refresh token
            const decoded = await this.tokenBuilder
                .setToken(refreshToken)
                .build()
                .verifyToken();

            if (decoded.type !== TokenType.REFRESH) {
                return next(errorResponseMessage.unauthorized("Invalid refresh token"));
            }

            const refreshPayload = decoded.data as IRefreshTokenPayload;

            // Verify token exists in database and is valid
            const tokenDoc = await this.refreshTokenService.findValidToken(refreshPayload.tokenId);
            if (!tokenDoc) {
                return next(errorResponseMessage.unauthorized("Invalid refresh token"));
            }

            // Find user
            const user = await this.userService.findById(refreshPayload.userId);
            if (!user) {
                return next(errorResponseMessage.resourceNotFound("User"));
            }

            // Revoke current refresh token
            await this.refreshTokenService.revokeToken(refreshPayload.tokenId);

            // Re-issue with the policy chosen at login (tokens from before the option existed stay persistent)
            const { accessToken: newAccessToken, refreshToken: newRefreshToken } =
                await this.issueSession(req, res, user, refreshPayload.rememberMe !== false);

            this.sendSuccess(res, {
                accessToken: newAccessToken,
                refreshToken: newRefreshToken
            });
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Issues an access + refresh token pair, stores the refresh token and sets the auth cookies.
     *
     * With `rememberMe` the session survives closing the browser: persistent cookies and a
     * 30-day refresh token (renewed on each refresh). Without it, the cookies are session
     * cookies (no expiry, so the browser drops them on close) and the refresh token is capped
     * at 1 day server-side. The choice is stored in the refresh token so refreshes keep it.
     * @private
     */
    private async issueSession(req: Request, res: Response, user: IUser, rememberMe: boolean) {
        const refreshDays = rememberMe ? 30 : 1;
        const accessToken = this.tokenBuilder.build().createToken(user, {
            type: TokenType.ACCESS,
            expiresIn: '1h'
        });
        const refreshToken = this.tokenBuilder.build().createToken(user, {
            type: TokenType.REFRESH,
            expiresIn: `${refreshDays}d`,
            rememberMe,
        });

        const decodedRefresh = await this.tokenBuilder.setToken(refreshToken).build().verifyToken();
        if (decodedRefresh && decodedRefresh.type === TokenType.REFRESH) {
            await this.refreshTokenService.saveRefreshToken(
                user._id as string,
                (decodedRefresh.data as IRefreshTokenPayload).tokenId,
                req.headers['user-agent'],
                req.ip,
                undefined,
                TokenUtils.getRefreshTokenExpiry(refreshDays)
            );
        }

        const base = {
            secure: config.NODE_ENV === 'production',
            sameSite: 'lax' as const,
            path: "/",
            domain: config.COOKIE_DOMAIN,
        };
        // Omitting maxAge makes a session cookie
        const lifetime = (ms: number) => (rememberMe ? { maxAge: ms } : {});
        const refreshMs = refreshDays * 24 * 60 * 60 * 1000;

        res.cookie('accessToken', accessToken, { ...base, httpOnly: true, ...lifetime(60 * 60 * 1000) });
        res.cookie('refreshToken', refreshToken, { ...base, httpOnly: true, ...lifetime(refreshMs) });
        res.cookie('role', Object.entries(ROLE_MAP).find(([_, v]) => v === user.role)?.[0], {
            ...base,
            httpOnly: false, // Readable client-side
            ...lifetime(refreshMs),
        });

        return { accessToken, refreshToken };
    }

    /**
     * Logs out the user from all sessions by revoking all their refresh tokens.
     * @private
     */
    private async logoutAll (_req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // Get the user ID from the request (added by auth middleware)
            const user = res.locals.user;

            if (!user._id) {
                return next(errorResponseMessage.unauthorized("User not authenticated"));
            }

            // Revoke all refresh tokens for the user
            await this.refreshTokenService.revokeAllUserTokens(user._id);

            // Clear cookies
            res.clearCookie('accessToken', {
                domain: config.COOKIE_DOMAIN,
                secure: config.NODE_ENV === 'production',
                // secure: true,
                sameSite: 'lax',
                path: "/",
                httpOnly: true,
            });

            res.clearCookie('refreshToken', {
                domain: config.COOKIE_DOMAIN,
                secure: config.NODE_ENV === 'production',
                // secure: true,
                sameSite: 'lax',
                path: "/",
                httpOnly: true,
            });

            res.clearCookie('role', {
                domain: config.COOKIE_DOMAIN,
                secure: config.NODE_ENV === 'production',
                // secure: true,
                sameSite: 'lax',
                path: "/",
                httpOnly: false
            });

            this.sendSuccess(res, {
                message: "Logged out from all sessions successfully"
            });
        } catch (error) {
            return next(error);
        }
    };

}

export default new AuthController().router;