import { NextFunction, Request, Response } from "express";
import { ROLE_MAP } from "../common/constant";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { hasPermission, type AdminAccess, type Permission } from "../common/permissions";
import adminAccessService from "../services/admin-access.service";

const forbidden = (message = "You don't have permission to perform this action") =>
    errorResponseMessage.createError(403, message, ErrorSeverity.HIGH);

/**
 * The signed-in admin's access, worked out once per request and kept on
 * res.locals.access for handlers that hide fields (see accessOf).
 */
export async function accessOf(res: Response): Promise<AdminAccess> {
    if (res.locals.access) return res.locals.access as AdminAccess;
    const access = await adminAccessService.accessFor(res.locals.user);
    res.locals.access = access;
    return access;
}

/** Whether the signed-in admin holds a permission (for hiding parts of a response) */
export async function allowed(res: Response, permission: Permission): Promise<boolean> {
    return hasPermission(await accessOf(res), permission);
}

class RoleMiddleware {
    /**
     * Super admins only. Every route that hasn't been given a specific
     * permission stays here, so staff never reach something by default.
     */
    isAdmin = async (_req: Request, res: Response, next: NextFunction) => {
        try {
            if (!res.locals.user) return next(errorResponseMessage.unauthorized());
            const access = await accessOf(res);
            if (!access.superAdmin) return next(forbidden(res.locals.user.role === ROLE_MAP.ADMIN ? "Only a super admin can do this" : "Admin access required"));
            return next();
        } catch (error) {
            return next(error);
        }
    };

    /** Anyone on the admin team (super admin or staff), whatever their permissions */
    isStaff = async (_req: Request, res: Response, next: NextFunction) => {
        try {
            if (!res.locals.user) return next(errorResponseMessage.unauthorized());
            if (res.locals.user.role !== ROLE_MAP.ADMIN) return next(forbidden("Admin access required"));
            await accessOf(res);
            return next();
        } catch (error) {
            return next(error);
        }
    };

    /** Admins holding at least one of these permissions (super admins hold all) */
    can = (...permissions: Permission[]) => async (_req: Request, res: Response, next: NextFunction) => {
        try {
            if (!res.locals.user) return next(errorResponseMessage.unauthorized());
            const access = await accessOf(res);
            if (!permissions.some((p) => hasPermission(access, p))) return next(forbidden());
            return next();
        } catch (error) {
            return next(error);
        }
    };
}

export default new RoleMiddleware();
