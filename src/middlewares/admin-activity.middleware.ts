import { NextFunction, Request, Response } from "express";
import { ROLE_MAP } from "../common/constant";
import adminActivityService from "../services/admin-activity.service";

const CHANGES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Logs every change an admin makes (under /protected), with the outcome, once
 * the response is sent. Reads aren't logged.
 */
export function adminActivityLogger(req: Request, res: Response, next: NextFunction) {
    const user = res.locals.user;
    if (!user || user.role !== ROLE_MAP.ADMIN || !CHANGES.has(req.method)) return next();
    const path = req.path;
    const body = req.body;
    res.on("finish", () => {
        void adminActivityService.record({
            adminId: user.id,
            method: req.method,
            path,
            status: res.statusCode,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
            body,
        });
    });
    return next();
}
