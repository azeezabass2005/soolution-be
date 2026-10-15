import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import platformSettingsService from '../../../../services/platform-settings.service';
import errorResponseMessage, { ErrorSeverity } from '../../../../common/messages/error-response-message';

const invalid = (message: string) => errorResponseMessage.createError(400, message, ErrorSeverity.LOW);

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
            const { rateMarkupPercent, additionalFeePercent, providerBaseFeePercent, tierDailyLimitUsd } = req.body ?? {};

            const inRange = (v: any, min: number, max: number) =>
                typeof v === 'number' && isFinite(v) && v >= min && v <= max;

            if (rateMarkupPercent !== undefined && !inRange(rateMarkupPercent, 0, 50)) {
                return next(invalid('rateMarkupPercent must be between 0 and 50'));
            }
            if (additionalFeePercent !== undefined && !inRange(additionalFeePercent, 0, 10)) {
                return next(invalid('additionalFeePercent must be between 0 and 10'));
            }
            if (providerBaseFeePercent !== undefined) {
                if (typeof providerBaseFeePercent !== 'object' || providerBaseFeePercent === null) {
                    return next(invalid('providerBaseFeePercent must be an object'));
                }
                const { ogateway, yellowcard } = providerBaseFeePercent;
                if (ogateway !== undefined && !inRange(ogateway, 0, 10)) {
                    return next(invalid('providerBaseFeePercent.ogateway must be between 0 and 10'));
                }
                if (yellowcard !== undefined && !inRange(yellowcard, 0, 10)) {
                    return next(invalid('providerBaseFeePercent.yellowcard must be between 0 and 10'));
                }
            }

            if (tierDailyLimitUsd !== undefined) {
                if (typeof tierDailyLimitUsd !== 'object' || tierDailyLimitUsd === null) {
                    return next(invalid('tierDailyLimitUsd must be an object'));
                }
                const { tier1, tier2 } = tierDailyLimitUsd;
                const MAX_LIMIT = 100_000_000;
                if (tier1 !== undefined && !inRange(tier1, 0, MAX_LIMIT)) {
                    return next(invalid('Tier 1 daily limit must be a positive amount'));
                }
                if (tier2 !== undefined && !inRange(tier2, 0, MAX_LIMIT)) {
                    return next(invalid('Tier 2 daily limit must be a positive amount'));
                }
                const current = (await platformSettingsService.getSettings()).tierDailyLimitUsd;
                if ((tier1 ?? current?.tier1) > (tier2 ?? current?.tier2)) {
                    return next(invalid('The Tier 1 limit cannot be higher than the Tier 2 limit'));
                }
            }

            const updated = await platformSettingsService.updateSettings(
                { rateMarkupPercent, additionalFeePercent, providerBaseFeePercent, tierDailyLimitUsd },
                String(user._id),
            );
            return this.sendSuccess(res, { settings: updated });
        } catch (error) {
            return next(error);
        }
    }
}

export default new AdminPlatformSettingsController().router;
