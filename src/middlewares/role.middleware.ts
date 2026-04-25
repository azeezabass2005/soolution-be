import {NextFunction, Request, Response} from "express";
import {ROLE_MAP} from "../common/constant";
import errorResponseMessage, {ErrorResponse, ErrorSeverity} from "../common/messages/error-response-message";

type RoleType = keyof typeof ROLE_MAP;
type RoleNumber = typeof ROLE_MAP[RoleType];

class RoleMiddleware {
    /**
     * Returns a middleware that allows the request only if the authenticated
     * user's role is included in `allowedRoles`.
     */
    hasRole(allowedRoles: RoleNumber | RoleNumber[]) {
        const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
        return (_req: Request, res: Response, next: NextFunction) => {
            const user = res.locals.user;
            if (!user) {
                return next(errorResponseMessage.unauthorized());
            }
            if (!roles.includes(user.role)) {
                return next(errorResponseMessage.createError(
                    403,
                    "You don't have permission to perform this action",
                    ErrorSeverity.HIGH
                ));
            }
            return next();
        };
    }

    /**
     * Allows the request only if the authenticated user has the ADMIN role.
     * Arrow-bound so it can be passed as a bare middleware reference
     * (e.g. `RoleMiddleware.isAdmin`) without losing `this`.
     */
    isAdmin = (_req: Request, res: Response, next: NextFunction) => {
        const user = res.locals.user;
        if (!user) {
            return next(errorResponseMessage.unauthorized());
        }
        if (user.role !== ROLE_MAP.ADMIN) {
            return next(errorResponseMessage.createError(
                403,
                "Admin access required",
                ErrorSeverity.HIGH
            ));
        }
        return next();
    };

    /**
     * Checks if user is the owner of the resource or an admin
     * @param resourceUserId string of the user id or an error that occurred when getting it
     * @param req
     * @param res
     * @param next
    */
    async isOwnerOrAdmin(resourceUserId: string | ErrorResponse, req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;

            if (!user) {
                return next(errorResponseMessage.unauthorized());
            }

            // If user is admin, allow access
            if (user.role === ROLE_MAP.ADMIN) {
                return next();
            }

            // Check if resource user id ror
            if(typeof resourceUserId !== 'string') {
                return next(resourceUserId)
            }

            // Check if user is the owner
            if (user._id.toString() !== resourceUserId) {
                return next(errorResponseMessage.createError(
                    403,
                    "You don't have permission to perform this action",
                    ErrorSeverity.HIGH
                ));
            }

            next();
        } catch (error) {
            next(error);
        }
    }
}

export default new RoleMiddleware();
