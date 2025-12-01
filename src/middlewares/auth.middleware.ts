import { Request, Response, NextFunction } from "express";
import TokenBuilder from "../utils/token.utils";
import UserService from "../services/user.service";

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

            // Extract token from either Authorization header or accessToken cookie
            let tokenString: string | undefined;

            if (authorization) {
                // Token from Authorization header
                tokenString = authorization;
            } else if (req.headers.cookie) {
                // Token from cookie
                tokenString = this.extractTokenFromCookie(req.headers.cookie);
            }

            if (!tokenString) {
                res.status(401).json({
                    success: false,
                    message: "Unauthorized: Missing token"
                });
                return;
            }

            // Validate and parse token
            const token = this.parseToken(tokenString);
            const { data, iat, exp }: any = await token.verifyToken();

            // Validate token contents
            if (!data?.email || !data?.userId) {
                res.status(401).json({
                    success: false,
                    message: "Unauthorized: Invalid token data"
                });
                return;
            }

            // Attach user info to response locals
            res.locals.userId = data.userId;
            res.locals.email = data.email;

            // Verify user exists
            await this.verifyUser(res);

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
     * Extracts access token from cookie string
     * @param cookieString Cookie header string
     * @returns Access token or undefined
     */
    private extractTokenFromCookie(cookieString: string): string | undefined {
        const cookies = cookieString.split(';').map(cookie => cookie.trim());

        for (const cookie of cookies) {
            const [name, value] = cookie.split('=');
            if (name === 'accessToken') {
                return `Bearer ${value}`;
            }
        }

        return undefined;
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
        const userService = new UserService();
        const getUser = await userService.findOne({
            _id: res.locals.userId,
            email: res.locals.email,
        });


        if (!getUser?._id) {
            throw new Error("User not found");
        }

        // Remove sensitive information
        const { password, ...user } = getUser?.toJSON();
        res.locals.user = user;
    }
}

export default new AuthMiddleware();