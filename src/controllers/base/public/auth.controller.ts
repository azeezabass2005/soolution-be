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
import {parsePostRegistration} from "../../../validators/z-register";
import {IUser} from "../../../models/interface";
import config from "../../../config/env.config";
import NotificationService from "../../../utils/notification.utils";
import PinService from "../../../services/pin.service";
import WalletService from "../../../services/wallet.service";
import { SESSION, SESSION_CODE } from "../../../config/session.config";
import crypto from "crypto";
import rateLimit from "express-rate-limit";

/** Changes whenever the password does, so a reset link only works once */
const passwordFingerprint = (passwordHash?: string) =>
    crypto.createHmac("sha256", config.JWT_SECRET).update(String(passwordHash || "")).digest("hex").slice(0, 24);
import User from "../../../models/user.model";

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
        // Each request sends an email; keep it from being used to flood an inbox
        const forgotLimiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 5,
            standardHeaders: true,
            legacyHeaders: false,
            message: { message: "Too many reset requests. Please wait a few minutes and try again." },
        });
        const resetLimiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 10,
            standardHeaders: true,
            legacyHeaders: false,
            message: { message: "Too many attempts. Please wait a few minutes and try again." },
        });
        this.router.post("/forgot-password", forgotLimiter, this.forgotPassword.bind(this));

        // Reset password route
        this.router.post("/reset-password", resetLimiter, this.resetPassword.bind(this));

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

            // Every account starts with an NGN wallet. If this fails, the wallet
            // is created on first visit (and by the startup backfill), so don't block sign-up.
            try {
                await new WalletService().getOrCreateWallet(String(user._id));
            } catch (error) {
                this.logger.error('Failed to create NGN wallet at sign-up', {
                    userId: user._id,
                    error: error instanceof Error ? error.message : String(error),
                });
            }

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
                userId: user._id,
                registrationToken: this.createRegistrationToken(user)
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
            // The token issued at sign-up (or at sign-in while sign-up is unfinished) proves who is completing it
            const registrationToken = req.body?.registrationToken || req.headers['x-registration-token'];
            if (!registrationToken || typeof registrationToken !== 'string') {
                return next(errorResponseMessage.unauthorized("Your sign-up session has expired. Please sign in to continue."));
            }

            let tokenUserId: string | undefined;
            try {
                const decoded = await this.tokenBuilder.setToken(registrationToken).build().verifyToken();
                if (decoded.type === TokenType.REGISTRATION) tokenUserId = decoded.data?.userId;
            } catch {
                tokenUserId = undefined;
            }
            if (!tokenUserId) {
                return next(errorResponseMessage.unauthorized("Your sign-up session has expired. Please sign in to continue."));
            }

            const { userId } = req.query;
            if (userId && String(userId) !== String(tokenUserId)) {
                return next(errorResponseMessage.unauthorized("This sign-up session belongs to a different account."));
            }

            const userExists = await this.userService.findById(tokenUserId);

            if(!userExists) {
                return next(errorResponseMessage.createError(
                    ErrorResponseCode.NOT_FOUND,
                    "User not found",
                    ErrorSeverity.HIGH
                ))
            }

            if (userExists.isCompleted) {
                return next(errorResponseMessage.createError(
                    ErrorResponseCode.RESOURCE_ALREADY_EXISTS,
                    "Your registration is already complete. Please sign in.",
                    ErrorSeverity.LOW
                ));
            }

            // Only the validated sign-up fields; never role, tier or verification flags from the request
            const registrationCompletionData = parsePostRegistration(req.body);

            const completeUser = await this.userService.updateById(tokenUserId, {...registrationCompletionData, isCompleted: true})

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
                    role: Object.entries(ROLE_MAP).find(([_, v]) => v === completeUser.role)?.[0],
                    purpose: completeUser.purpose
                }
            })
        } catch(error) {
            return next(error)
        }
    }

    /** A short-lived token that only lets this user finish sign-up */
    private createRegistrationToken(user: IUser): string {
        return this.tokenBuilder.build().createToken(user, {
            type: TokenType.REGISTRATION,
            expiresIn: '2h'
        });
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
                    userId: user._id,
                    registrationToken: this.createRegistrationToken(user)
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
            const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return next(errorResponseMessage.payloadIncorrect("Enter a valid email address"));
            }

            // Same answer whether or not the account exists, so this can't be used to find accounts
            this.sendSuccess(res, {
                message: "If an account exists for that email, we've sent a link to reset your password.",
            });

            try {
                const user = await this.userService.findOne({ email }, { select: ['+password'] });
                if (!user || user.status !== 'active') return;
                const token = this.tokenBuilder.build().createToken(user, {
                    type: TokenType.RESET,
                    expiresIn: '30m',
                    passwordFingerprint: passwordFingerprint(user.password),
                });
                const resetUrl = `${config.FRONTEND_URL}/auth/reset-password?token=${encodeURIComponent(token)}`;
                await this.notificationService.emailService.sendPasswordResetEmail(user.email, {
                    name: user.firstName || 'there',
                    resetUrl,
                    expiryTime: '30 minutes',
                });
                this.logger.info("Password reset email sent", { userId: user._id });
            } catch (sendError) {
                this.logger.error("Failed to send password reset email", {
                    error: sendError instanceof Error ? sendError.message : String(sendError),
                });
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
            const { token, newPassword } = req.body || {};
            const invalidLink = () => errorResponseMessage.createError(400, "This reset link is invalid or has expired. Request a new one.", ErrorSeverity.LOW, { code: "RESET_LINK_INVALID" });

            if (typeof token !== "string" || !token) return next(invalidLink());
            if (typeof newPassword !== "string" || newPassword.length < 8) {
                return next(errorResponseMessage.createError(400, "Password must be at least 8 characters.", ErrorSeverity.LOW, { issues: [{ path: "newPassword", message: "Use at least 8 characters" }] }));
            }
            if (newPassword.length > 128) {
                return next(errorResponseMessage.createError(400, "Password is too long.", ErrorSeverity.LOW));
            }

            let decoded: any;
            try {
                decoded = await this.tokenBuilder.setToken(token).build().verifyToken();
            } catch {
                return next(invalidLink());
            }
            if (decoded?.type !== TokenType.RESET || !decoded?.data?.userId || !decoded?.data?.pfp) {
                return next(invalidLink());
            }

            const user = await this.userService.findOne({ _id: decoded.data.userId }, { select: ['+password'] });
            // The link stops working once the password has changed, so it can only be used once
            if (!user || passwordFingerprint(user.password) !== decoded.data.pfp) {
                return next(invalidLink());
            }

            const hashedPassword = await HashService.hashPassword(newPassword);
            await this.userService.updateById(String(user._id), { password: hashedPassword.password });

            // A new password signs out every existing session
            await this.refreshTokenService.revokeAllUserTokens(user._id);
            await User.updateOne({ _id: user._id }, { $set: { sessionsValidAfter: new Date() } });
            this.logger.info("Password reset", { userId: user._id });

            this.notificationService.emailService.sendNotificationEmail(user.email, {
                name: user.firstName || 'there',
                eyebrow: 'Security',
                title: 'Your password was changed',
                message: "Your Solution Pay password was just reset, and you've been signed out on every device. If this wasn't you, contact support@solutionpay.co straight away.",
            }).catch((error: any) => this.logger.warn("Password change notice failed", { error: error?.message }));

            this.sendSuccess(res, {
                message: "Password reset. Sign in with your new password."
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

            const sessionEnded = (message: string) =>
                errorResponseMessage.createError(401, message, ErrorSeverity.LOW, { code: SESSION_CODE.SESSION_ENDED });

            // Spend the token (atomically, so two requests can't both use it)
            const tokenDoc = await this.refreshTokenService.consumeToken(refreshPayload.tokenId);
            if (!tokenDoc) {
                const stored = await this.refreshTokenService.findByTokenId(refreshPayload.tokenId);
                if (stored?.isRevoked) {
                    const revokedAgo = Date.now() - new Date(stored.revokedAt || (stored as any).updatedAt || 0).getTime();
                    if (revokedAgo <= SESSION.REFRESH_REUSE_GRACE_MS) {
                        // Another tab refreshed with it a moment ago; the browser already has the new cookies
                        return next(errorResponseMessage.createError(401, "Session refreshed in another tab", ErrorSeverity.LOW, { code: SESSION_CODE.REFRESH_RACED }));
                    }
                    // A used token coming back later means it was copied: end every session for this user
                    this.logger.warn("Refresh token reused; signing the user out everywhere", { userId: refreshPayload.userId, ip: req.ip });
                    await this.refreshTokenService.revokeAllUserTokens(refreshPayload.userId);
                    await User.updateOne({ _id: refreshPayload.userId }, { $set: { sessionsValidAfter: new Date() } });
                }
                return next(sessionEnded("Your session has ended. Please sign in again."));
            }

            // Find user
            const user = await this.userService.findById(refreshPayload.userId);
            if (!user) {
                return next(errorResponseMessage.resourceNotFound("User"));
            }
            if (user.sessionsValidAfter && (decoded as any).iat * 1000 < new Date(user.sessionsValidAfter).getTime() - 1000) {
                return next(sessionEnded("Your session has ended. Please sign in again."));
            }

            // Hard cap: after MAX_SESSION_MS the password is needed again, however active the user is.
            // Tokens from before this existed start their 30 days now.
            const sessionStartedAt = refreshPayload.sessionStartedAt ?? Date.now();
            if (Date.now() - sessionStartedAt > SESSION.MAX_SESSION_MS) {
                return next(sessionEnded("For your security, please sign in again."));
            }

            // Re-issue with the policy chosen at login (tokens from before the option existed stay persistent)
            const { accessToken: newAccessToken, refreshToken: newRefreshToken } =
                await this.issueSession(req, res, user, refreshPayload.rememberMe !== false, sessionStartedAt);

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
    private async issueSession(req: Request, res: Response, user: IUser, rememberMe: boolean, sessionStartedAt: number = Date.now()) {
        // The refresh token lives for the idle window, but never past the session's hard cap
        const idleMs = rememberMe ? SESSION.REMEMBERED_REFRESH_TTL_MS : SESSION.REFRESH_TTL_MS;
        const refreshMs = Math.max(60 * 1000, Math.min(idleMs, sessionStartedAt + SESSION.MAX_SESSION_MS - Date.now()));
        const accessToken = this.tokenBuilder.build().createToken(user, {
            type: TokenType.ACCESS,
            expiresIn: `${Math.round(SESSION.ACCESS_TTL_MS / 1000)}s`,
        });
        const refreshToken = this.tokenBuilder.build().createToken(user, {
            type: TokenType.REFRESH,
            expiresIn: `${Math.round(refreshMs / 1000)}s`,
            rememberMe,
            sessionStartedAt,
        });

        const decodedRefresh = await this.tokenBuilder.setToken(refreshToken).build().verifyToken();
        if (decodedRefresh && decodedRefresh.type === TokenType.REFRESH) {
            await this.refreshTokenService.saveRefreshToken(
                user._id as string,
                (decodedRefresh.data as IRefreshTokenPayload).tokenId,
                req.headers['user-agent'],
                req.ip,
                undefined,
                new Date(Date.now() + refreshMs)
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

        res.cookie('accessToken', accessToken, { ...base, httpOnly: true, ...lifetime(SESSION.ACCESS_TTL_MS) });
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

            // Revoke all refresh tokens, and refuse access tokens already handed out
            await this.refreshTokenService.revokeAllUserTokens(user._id);
            await User.updateOne({ _id: user._id }, { $set: { sessionsValidAfter: new Date() } });

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