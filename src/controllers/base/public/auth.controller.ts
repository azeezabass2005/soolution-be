import {NextFunction, Request, Response} from "express";
import BaseController from "../base-controller";
import { passwordProblem } from "../../../common/password-policy";
import HashService from "../../../utils/hash.utils";
import TokenBuilder, {TokenUtils} from "../../../utils/token.utils";
import errorResponseMessage, {ErrorResponseCode, ErrorSeverity} from "../../../common/messages/error-response-message";
import {IRefreshTokenPayload, TokenType} from "../../../utils/interface";
import {ROLE_MAP} from "../../../common/constant";
import RefreshTokenService from "../../../services/refresh.service";
import authMiddleware from "../../../middlewares/auth.middleware";
import {loginValidate, postRegisterValidate, registerValidate, validateResetTransactionPin} from "../../../validators";
import {parsePostRegistration} from "../../../validators/z-register";
import type { User as IUser } from "../../../types/entities";
import config from "../../../config/env.config";
import NotificationService from "../../../utils/notification.utils";
import PinService from "../../../services/pin.service";
import WalletService from "../../../services/wallet.service";
import { SESSION, SESSION_CODE } from "../../../config/session.config";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { authCookieBase, clearAuthCookies, clearLegacyAuthCookies, cookieValues } from "../../../utils/auth-cookies";
import loginOtpService, { LOGIN_OTP_RESEND_MS, LOGIN_OTP_TTL_MS, LoginOtpError, maskEmail } from "../../../services/login-otp.service";

/** Changes whenever the password does, so a reset link only works once */
const passwordFingerprint = (passwordHash?: string) =>
    crypto.createHmac("sha256", config.JWT_SECRET).update(String(passwordHash || "")).digest("hex").slice(0, 24);

/** "Chrome on Windows", for the sign-in code email */
function describeDevice(userAgent?: string): string {
    const ua = String(userAgent || "");
    if (!ua) return "";
    const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
        : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
    const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows"
        : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
    return [browser, os].filter(Boolean).join(" on ");
}

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

        // Sign-in: the password, then a code sent by email
        const authLimiter = (max: number) => rateLimit({
            windowMs: 15 * 60 * 1000,
            max,
            standardHeaders: true,
            legacyHeaders: false,
            message: { message: "Too many attempts. Please wait a few minutes and try again." },
        });
        this.router.post("/login", authLimiter(30), loginValidate, this.login.bind(this));
        this.router.post("/login/verify", authLimiter(40), this.verifyLoginCode.bind(this));
        this.router.post("/login/resend", authLimiter(15), this.resendLoginCode.bind(this));

        // Verify email route
        this.router.post("/verify-email", authLimiter(30), this.verifyEmail.bind(this));
        this.router.post("/verify-email/resend", authLimiter(10), this.resendVerification.bind(this));

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

        // Sign out on this device only (e.g. after 30 minutes of inactivity)
        this.router.post("/logout", this.logout.bind(this));

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
            const existingUser = await this.userService.findByEmail(email);

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
            const user = await this.userService.register({
                email,
                firstName,
                lastName,
                password: hashedPassword.password,
                isVerified: false
            });

            // Every account starts with an NGN wallet. If this fails, the wallet
            // is created on first visit (and by the startup backfill), so don't block sign-up.
            try {
                await new WalletService().getOrCreateWallet(user.id);
            } catch (error) {
                this.logger.error('Failed to create NGN wallet at sign-up', {
                    userId: user.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            }

            // The welcome email follows the verification link (see verifyEmail)

            // Step 2 opens from the link in this email, not from here
            try {
                await this.sendVerificationLink(user);
            } catch (error) {
                this.logger.error('Failed to send the verification email at sign-up', {
                    userId: user.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            }

            this.sendSuccess(res, {
                message: "Check your email for a link to verify your address.",
                verificationRequired: true,
                email: maskEmail(user.email),
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

            if (!userExists.isVerified) {
                return next(errorResponseMessage.createError(403, "Verify your email first. Open the link we sent you.", ErrorSeverity.LOW, { code: "EMAIL_NOT_VERIFIED" }));
            }

            // Only the validated sign-up fields; never role, tier or verification flags from the request
            const registrationCompletionData = parsePostRegistration(req.body);

            const completeUser = await this.userService.update(tokenUserId, {...registrationCompletionData, isCompleted: true})

            if(!completeUser) {
                throw new Error("Failed to complete user registration");
            }

            // Sign the new user in (a persistent session, as before)
            const { accessToken, refreshToken } = await this.issueSession(req, res, completeUser, true);

            // Update last login timestamp
            await this.userService.update(completeUser.id, {
                lastLogin: new Date().toISOString()
            });

            this.sendSuccess(res, {
                accessToken,
                refreshToken,
                message: "Registration completed successfully. You are now logged in.",
                user: {
                    id: completeUser.id,
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

            const user = await this.userService.findByEmail(email, { withSecrets: true });
            if (!user) {
                return next(errorResponseMessage.unauthorized("Invalid credentials"));
            }

            if (user.status !== 'active') {
                return next(errorResponseMessage.unauthorized(`Login failed because your account has been ${user.status}. Reach out to support@solutionpay.co for further info`));
            }

            const isValidPassword = await HashService.verifyPassword(
                password,
                user.password!
            );

            if (!isValidPassword) {
                return next(errorResponseMessage.unauthorized("Invalid credentials"));
            }

            // The password is right, but the address was never verified: send a fresh link instead of a code
            if (!user.isVerified && user.role !== ROLE_MAP.ADMIN) {
                try {
                    await this.sendVerificationLink(user);
                } catch (error) {
                    this.logger.error('Failed to resend the verification email at sign-in', {
                        userId: user.id,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
                return next(errorResponseMessage.createError(
                    403,
                    `Verify your email to continue. We've sent a new link to ${maskEmail(user.email)}.`,
                    ErrorSeverity.LOW,
                    { code: "EMAIL_NOT_VERIFIED", email: maskEmail(user.email) },
                ));
            }

            // The password is right; the session waits for the code sent to their email
            const { challenge, code } = await loginOtpService.start(user.id, {
                rememberMe,
                ipAddress: req.ip,
                userAgent: req.headers['user-agent'],
            });
            try {
                await this.sendLoginCode(user, code, req);
            } catch (error) {
                await loginOtpService.close(challenge.id);
                this.logger.error('Failed to send sign-in code', {
                    userId: user.id,
                    error: error instanceof Error ? error.message : String(error),
                });
                return next(errorResponseMessage.createError(503, "We couldn't send your sign-in code. Please try again in a moment.", ErrorSeverity.HIGH, { code: "LOGIN_CODE_NOT_SENT" }));
            }

            this.sendSuccess(res, this.challengeResponse(challenge.id, user.email, "We've sent a 6-digit code to your email."));
        } catch (error) {
            if (error instanceof LoginOtpError) return next(this.otpError(error));
            return next(error);
        }
    }

    /** What the sign-in screen needs to show the code step */
    private challengeResponse(challengeId: string, email: string, message: string) {
        return {
            otpRequired: true,
            challengeId,
            email: maskEmail(email),
            expiresInSeconds: Math.round(LOGIN_OTP_TTL_MS / 1000),
            resendInSeconds: Math.round(LOGIN_OTP_RESEND_MS / 1000),
            message,
        };
    }

    private otpError(error: LoginOtpError) {
        return errorResponseMessage.createError(error.status, error.message, ErrorSeverity.LOW, { code: error.code, ...error.extra });
    }

    private async sendLoginCode(user: IUser, code: string, req: Request) {
        await this.notificationService.emailService.sendLoginCodeEmail(user.email, {
            name: user.firstName || 'there',
            code,
            expiryTime: `${Math.round(LOGIN_OTP_TTL_MS / 60000)} minutes`,
            device: describeDevice(req.headers['user-agent']),
        });
    }

    /**
     * Second sign-in step: the emailed code. Issues the session (or, for an
     * unfinished sign-up, the token to finish it).
     */
    private async verifyLoginCode (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { challengeId, code } = req.body || {};
            const challenge = await loginOtpService.verify(challengeId, code);

            const user = await this.userService.findById(challenge.userId);
            if (!user) {
                return next(errorResponseMessage.unauthorized("This sign-in has expired. Please sign in again."));
            }
            if (user.status !== 'active') {
                return next(errorResponseMessage.unauthorized(`Login failed because your account has been ${user.status}. Reach out to support@solutionpay.co for further info`));
            }

            if(!user?.isCompleted && user?.role !== ROLE_MAP.ADMIN) {
                return this.sendSuccess(res, {
                    message: "Registration not completed. Redirecting to completion step",
                    not_completed: true,
                    userId: user.id,
                    registrationToken: this.createRegistrationToken(user)
                });
            }

            const { accessToken, refreshToken } = await this.issueSession(req, res, user, challenge.rememberMe);

            // Update last login timestamp
            await this.userService.update(user.id, {
                lastLogin: new Date().toISOString()
            });

            // Tell the user about the sign-in (not awaited: the session is already issued)
            this.notificationService.emailService.sendNotificationEmail(
                user.email,
                {
                    title: '🔐 Login Successful',
                    message: `Hello ${user.firstName}, you have successfully logged into your Solution Pay account. If this wasn't you, please contact support immediately.`,
                    appName: 'Solution Pay',
                    actionUrl: `${config.FRONTEND_URL}/dashboard/user`,
                    buttonText: 'Go to Dashboard'
                }
            ).catch((error: any) => this.logger.error('Failed to send login notification email', {
                userId: user.id,
                error: error instanceof Error ? error.message : String(error),
                ip: req.ip
            }));

            this.sendSuccess(res, {
                accessToken,
                refreshToken,
                message: "You are successfully logged in.",
                user: {
                    id: user.id,
                    email: user.email,
                    role: Object.entries(ROLE_MAP).find(([_, v]) => v === user.role)?.[0]
                }
            });
        } catch (error) {
            if (error instanceof LoginOtpError) return next(this.otpError(error));
            return next(error);
        }
    }

    /** A new sign-in code for the same sign-in */
    private async resendLoginCode (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { challengeId } = req.body || {};
            const { challenge, code } = await loginOtpService.resend(challengeId);
            const user = await this.userService.findById(challenge.userId);
            if (!user || user.status !== 'active') {
                await loginOtpService.close(challenge.id);
                return next(errorResponseMessage.unauthorized("This sign-in has expired. Please sign in again."));
            }
            try {
                await this.sendLoginCode(user, code, req);
            } catch (error) {
                this.logger.error('Failed to resend sign-in code', {
                    userId: user.id,
                    error: error instanceof Error ? error.message : String(error),
                });
                return next(errorResponseMessage.createError(503, "We couldn't send a new code. Please try again in a moment.", ErrorSeverity.HIGH, { code: "LOGIN_CODE_NOT_SENT" }));
            }
            this.sendSuccess(res, this.challengeResponse(challenge.id, user.email, "We've sent you a new code."));
        } catch (error) {
            if (error instanceof LoginOtpError) return next(this.otpError(error));
            return next(error);
        }
    }

    /**
     * Verifies user's email address
     * @private
     */
    private async verifyEmail (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { token } = req.body || {};
            if (!token || typeof token !== 'string') {
                return next(errorResponseMessage.payloadIncorrect("Verification token is required"));
            }

            let userId: string | undefined;
            try {
                const decoded = await this.tokenBuilder.setToken(token).build().verifyToken();
                if (decoded.type === TokenType.VERIFY) userId = decoded.data?.userId;
            } catch {
                userId = undefined;
            }
            if (!userId) {
                return next(errorResponseMessage.createError(400, "This link has expired or isn't valid. Sign in and we'll send you a new one.", ErrorSeverity.LOW, { code: "VERIFY_LINK_INVALID" }));
            }

            const existing = await this.userService.findById(userId);
            if (!existing) return next(errorResponseMessage.resourceNotFound("User"));
            const firstTime = !existing.isVerified;
            const user = firstTime ? await this.userService.update(userId, { isVerified: true }) : existing;
            if (!user) return next(errorResponseMessage.resourceNotFound("User"));

            if (firstTime) {
                this.notificationService.emailService.sendWelcomeEmail(user.email, {
                    name: `${user.firstName} ${user.lastName}`,
                    appName: 'Solution Pay',
                    actionUrl: `${config.FRONTEND_URL}/dashboard/user`,
                    buttonText: 'Get Started'
                }).catch((error: any) => this.logger.error('Failed to send welcome email', {
                    userId: user.id,
                    error: error instanceof Error ? error.message : String(error),
                }));
            }

            // Sign-up continues in the browser that opened the link
            this.sendSuccess(res, {
                message: "Email verified.",
                email: maskEmail(user.email),
                ...(user.isCompleted ? { completed: true } : { userId: user.id, registrationToken: this.createRegistrationToken(user) }),
            });
        } catch (error) {
            return next(error);
        }
    }

    /** A new verification link; says the same whether or not the address has an account */
    private async resendVerification (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const email = String(req.body?.email || '').trim();
            const user = email ? await this.userService.findByEmail(email) : null;
            if (user && !user.isVerified) {
                try {
                    await this.sendVerificationLink(user);
                } catch (error) {
                    this.logger.error('Failed to resend the verification email', {
                        userId: user.id,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            this.sendSuccess(res, { message: "If that address needs verifying, a new link is on its way." });
        } catch (error) {
            return next(error);
        }
    }

    /** Emails the link that verifies the address and opens the next sign-up step (valid 24 hours) */
    private async sendVerificationLink(user: IUser) {
        const token = this.tokenBuilder.build().createToken(user, { type: TokenType.VERIFY, expiresIn: '24h' });
        await this.notificationService.emailService.sendVerificationEmail(user.email, {
            name: user.firstName || 'there',
            verificationUrl: `${config.FRONTEND_URL}/auth/verify-email?token=${encodeURIComponent(token)}`,
            expiryTime: '24 hours',
        });
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
                const user = await this.userService.findByEmail(email, { withSecrets: true });
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
                this.logger.info("Password reset email sent", { userId: user.id });
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
            const weak = (problem: string) => errorResponseMessage.createError(400, problem, ErrorSeverity.LOW, { issues: [{ path: "newPassword", message: problem }] });
            const generalProblem = passwordProblem(newPassword);
            if (generalProblem) return next(weak(generalProblem));

            let decoded: any;
            try {
                decoded = await this.tokenBuilder.setToken(token).build().verifyToken();
            } catch {
                return next(invalidLink());
            }
            if (decoded?.type !== TokenType.RESET || !decoded?.data?.userId || !decoded?.data?.pfp) {
                return next(invalidLink());
            }

            const user = await this.userService.findById(decoded.data.userId, { withSecrets: true });
            // The link stops working once the password has changed, so it can only be used once
            if (!user || passwordFingerprint(user.password) !== decoded.data.pfp) {
                return next(invalidLink());
            }

            const personalProblem = passwordProblem(newPassword, user);
            if (personalProblem) return next(weak(personalProblem));

            const hashedPassword = await HashService.hashPassword(newPassword);
            await this.userService.update(user.id, { password: hashedPassword.password });

            // A new password signs out every existing session
            await this.userService.endAllSessions(user.id);
            this.logger.info("Password reset", { userId: user.id });

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


            // A browser can send refreshToken twice (an old shared-domain cookie
            // next to this environment's): use the ones this server signed
            const presented = cookieValues(req.headers?.cookie, 'refreshToken');
            if (!presented.length) {
                return next(errorResponseMessage.payloadIncorrect("Refresh token is required"));
            }
            const candidates: Array<{ decoded: any; payload: IRefreshTokenPayload }> = [];
            for (const value of presented) {
                try {
                    const decoded: any = await this.tokenBuilder.setToken(value).build().verifyToken();
                    if (decoded?.type === TokenType.REFRESH) candidates.push({ decoded, payload: decoded.data as IRefreshTokenPayload });
                } catch {
                    // Another environment's token, or expired: not ours to use
                }
            }
            if (!candidates.length) {
                clearLegacyAuthCookies(res);
                return next(errorResponseMessage.unauthorized("Invalid refresh token"));
            }

            const sessionEnded = (message: string) =>
                errorResponseMessage.createError(401, message, ErrorSeverity.LOW, { code: SESSION_CODE.SESSION_ENDED });

            // Spend the token (atomically, so two requests can't both use it)
            let tokenDoc: Awaited<ReturnType<RefreshTokenService["consumeToken"]>>;
            let decoded = candidates[0].decoded;
            let refreshPayload = candidates[0].payload;
            for (const candidate of candidates) {
                tokenDoc = await this.refreshTokenService.consumeToken(candidate.payload.tokenId);
                if (tokenDoc) {
                    ({ decoded, payload: refreshPayload } = candidate);
                    break;
                }
            }
            // With two cookies, a spent one is the old leftover, not a stolen copy
            if (!tokenDoc! && candidates.length > 1) {
                clearLegacyAuthCookies(res);
                return next(sessionEnded("Your session has ended. Please sign in again."));
            }
            if (!tokenDoc!) {
                const stored = await this.refreshTokenService.findByTokenId(refreshPayload.tokenId);
                if (stored?.isRevoked) {
                    const revokedAgo = Date.now() - new Date(stored.revokedAt || stored.updatedAt || 0).getTime();
                    if (revokedAgo <= SESSION.REFRESH_REUSE_GRACE_MS) {
                        // Another tab refreshed with it a moment ago; the browser already has the new cookies
                        return next(errorResponseMessage.createError(401, "Session refreshed in another tab", ErrorSeverity.LOW, { code: SESSION_CODE.REFRESH_RACED }));
                    }
                    // A used token coming back later means it was copied: end every session for this user
                    this.logger.warn("Refresh token reused; signing the user out everywhere", { userId: refreshPayload.userId, ip: req.ip });
                    await this.userService.endAllSessions(refreshPayload.userId);
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
     * 7-day refresh token (renewed on each refresh). Without it, the cookies are session
     * cookies (no expiry, so the browser drops them on close) and the refresh token lasts
     * 12 hours. Either way the refresh token never outlives SESSION.MAX_SESSION_MS (30 days)
     * from sign-in. The choice is stored in the refresh token so refreshes keep it.
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
                user.id,
                (decodedRefresh.data as IRefreshTokenPayload).tokenId,
                req.headers['user-agent'],
                req.ip,
                undefined,
                new Date(Date.now() + refreshMs)
            );
        }

        const base = authCookieBase();
        // Old shared-domain cookies would shadow these; drop them
        clearLegacyAuthCookies(res);
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
     * Signs out this browser: its refresh token stops working and the cookies
     * are cleared. Needs no access token (it may have expired while idle).
     * Other devices stay signed in.
     */
    private async logout (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            for (const value of cookieValues(req.headers?.cookie, 'refreshToken')) {
                try {
                    const decoded: any = await this.tokenBuilder.setToken(value).build().verifyToken();
                    if (decoded?.type === TokenType.REFRESH) {
                        await this.refreshTokenService.consumeToken((decoded.data as IRefreshTokenPayload).tokenId);
                    }
                } catch {
                    // Expired or another environment's: nothing to revoke
                }
            }
            clearAuthCookies(res);
            this.sendSuccess(res, { message: "Signed out" });
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Logs out the user from all sessions by revoking all their refresh tokens.
     * @private
     */
    private async logoutAll (_req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // Get the user ID from the request (added by auth middleware)
            const user = res.locals.user;

            if (!user?.id) {
                return next(errorResponseMessage.unauthorized("User not authenticated"));
            }

            // Revoke all refresh tokens, and refuse access tokens already handed out
            await this.userService.endAllSessions(user.id);

            // Clear cookies (and any old shared-domain ones)
            clearAuthCookies(res);

            this.sendSuccess(res, {
                message: "Logged out from all sessions successfully"
            });
        } catch (error) {
            return next(error);
        }
    };

}

export default new AuthController().router;