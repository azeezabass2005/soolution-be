import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import platformSettingsService from '../../../../services/platform-settings.service';

/**
 * Admin endpoints for the universal pricing settings. Mounted at
 * /protected/admin/platform-settings. All routes admin-gated.
 */
class AdminPlatformSettingsController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.use(RoleMiddleware.isAdmin);
        this.router.get('/', this.get.bind(this));
        this.router.put('/', this.put.bind(this));
    }

    private async get(_req: Request, res: Response, next: NextFunction) {
        try {
            const settings = await platformSettingsService.getSettings();
            return this.sendSuccess(res, { settings });
        } catch (error) {
            return next(error);
        }
    }

    private async put(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const { rateMarkupPercent, additionalFeePercent, providerBaseFeePercent } = req.body ?? {};

            const inRange = (v: any, min: number, max: number) =>
                typeof v === 'number' && isFinite(v) && v >= min && v <= max;

            if (rateMarkupPercent !== undefined && !inRange(rateMarkupPercent, 0, 50)) {
                return next({ response_code: 400, message: 'rateMarkupPercent must be between 0 and 50' });
            }
            if (additionalFeePercent !== undefined && !inRange(additionalFeePercent, 0, 10)) {
                return next({ response_code: 400, message: 'additionalFeePercent must be between 0 and 10' });
            }
            if (providerBaseFeePercent !== undefined) {
                if (typeof providerBaseFeePercent !== 'object' || providerBaseFeePercent === null) {
                    return next({ response_code: 400, message: 'providerBaseFeePercent must be an object' });
                }
                const { ogateway, yellowcard } = providerBaseFeePercent;
                if (ogateway !== undefined && !inRange(ogateway, 0, 10)) {
                    return next({ response_code: 400, message: 'providerBaseFeePercent.ogateway must be between 0 and 10' });
                }
                if (yellowcard !== undefined && !inRange(yellowcard, 0, 10)) {
                    return next({ response_code: 400, message: 'providerBaseFeePercent.yellowcard must be between 0 and 10' });
                }
            }

            const updated = await platformSettingsService.updateSettings(
                { rateMarkupPercent, additionalFeePercent, providerBaseFeePercent },
                String(user._id),
            );
            return this.sendSuccess(res, { settings: updated });
        } catch (error) {
            return next(error);
        }
    }
}

export default new AdminPlatformSettingsController().router;
