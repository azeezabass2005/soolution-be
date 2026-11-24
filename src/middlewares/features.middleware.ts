import { NextFunction, Request, Response } from "express";
import { featureOfRoute } from "../common/features";
import featuresService from "../services/features.service";

/** Refuses a route whose feature is off (or beta-only) for this user */
export async function featureGuard(req: Request, res: Response, next: NextFunction) {
    try {
        const feature = featureOfRoute(req.method, req.path);
        if (!feature || !res.locals.user) return next();
        await featuresService.assert(feature.key, res.locals.user);
        return next();
    } catch (error) {
        return next(error);
    }
}
