import { Request, Response, NextFunction } from "express";
import TokenBuilder from "../utils/token.utils";
import { TokenType } from "../utils/interface";
import UserService from "../services/user.service";
import { cookieValues } from "../utils/auth-cookies";

const userService = new UserService();

class AuthMiddleware {
    /**
     * Validates the presence of authorization header or cookie
     * @param req Express request object
     * @param res Express response object
     * @param next Next middleware function
     */
    async validateAuthorization(
        req: Request,
        res: Response,
        next: NextFunction
    ) {
        try {

            const { authorization } = req.headers;

            // The Authorization header, or the accessToken cookie. A browser can
            // send that cookie twice (an old shared-domain one next to this
            // environment's), so each is tried and the first valid one is used.
            const candidates = authorization
                ? [authorization]
                : cookieValues(req.headers.cookie, "accessToken").map((value) => `Bearer ${value}`);

            if (!candidates.length) {
                res.status(401).json({
                    success: false,
                    message: "Unauthorized: Missing token"
                });
                return;
            }

            let verified: any;
            let lastError: unknown;
            for (const tokenString of candidates) {
                try {
                    const decoded: any = await this.parseToken(tokenString).verifyToken();
                    // Only access tokens open a session (not refresh, reset or registration tokens)
                    if (decoded?.type && decoded.type !== TokenType.ACCESS) continue;
                    if (!decoded?.data?.email || !decoded?.data?.userId) continue;
                    verified = decoded;
                    break;
                } catch (error) {
                    lastError = error;
                }
            }
            if (!verified) {
                if (lastError) throw lastError;
                res.status(401).json({
                    success: false,
                    message: "Unauthorized: Invalid token"
                });
                return;
            }
            const { data, iat } = verified;

            // Attach user info to response locals
            res.locals.userId = data.userId;
            res.locals.email = data.email;

            // Verify user exists
            await this.verifyUser(res);

            // Signed out everywhere (or password reset) after this token was issued
            const validAfter = res.locals.user?.sessionsValidAfter;
            if (validAfter && iat * 1000 < new Date(validAfter).getTime() - 1000) {
                res.status(401).json({ success: false, message: "Unauthorized: Session ended" });
                return;
            }

            next();
            return;
        } catch (error) {
            console.error("Authorization error:", error);
            res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
            return;
        }
    }

    async logoutAll(
        req: Request,
        res: Response,
        next: NextFunction
    ) {
        // Implementation for logout all functionality
    }


    /**
     * Parses the authorization token
     * @param authorization Authorization header string or formatted token
     * @returns Parsed token
     */
    private parseToken(authorization: string) {
        const splitToken = authorization.split(" ");

        if (splitToken.length > 2) {
            throw new Error("Invalid token format");
        }

        const _token = splitToken.length === 2 ? splitToken[1] : splitToken[0];
        return new TokenBuilder().setToken(_token).build();
    }

    /**
     * Verifies the user exists in the database
     * @param res Express response object
     */
    private async verifyUser(res: Response) {
        // Never includes the password or PIN hash
        const user = await userService.findForSession(res.locals.userId, res.locals.email);

        if (!user?.id) {
            throw new Error("User not found");
        }

        res.locals.user = user;
    }
}

export default new AuthMiddleware();