import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware, { allowed } from '../../../../middlewares/role.middleware';
import type { Permission } from '../../../../common/permissions';
import platformSettingsService from '../../../../services/platform-settings.service';
import errorResponseMessage, { ErrorSeverity } from '../../../../common/messages/error-response-message';
import { PricingError, legacyNgnFeePairs } from '../../../../common/pricing';
import { OperationsError, manualWindow } from '../../../../common/operations';
import ycRateService from '../../../../services/yc-rate.service';
import { YELLOWCARD_FLOW_CURRENCIES } from '../../../../common/payment-link.constants';

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
        // Anyone who manages a part of these settings can read them; saving checks each part (see put)
        this.router.use(RoleMiddleware.can('pricing.api_currencies', 'pricing.manual_payments', 'pricing.daily_limits', 'platform_controls', 'dashboard.platform_controls', 'profit_balances'));
        this.router.get('/', this.get.bind(this));
        // How each YellowCard currency's naira rate is made right now (pricing admins)
        this.router.get('/yellowcard-rates', RoleMiddleware.can('pricing.api_currencies'), this.yellowCardRates.bind(this));
        this.router.put('/', this.put.bind(this));
    }

    private async get(_req: Request, res: Response, next: NextFunction) {
        try {
            const settings = await platformSettingsService.getSettings();
            // The effective pricing, defaults filled in
            const pricing = await platformSettingsService.getPricing();
            const operations = await platformSettingsService.getOperations();
            // Pairs whose fixed fee amounts are still in NGN: the admin reviews them in the pair's currency
            const inheritedPairs = await platformSettingsService.inheritedYellowCardPairs();
            return this.sendSuccess(res, { settings: { ...settings, pricing, operations, manualWindow: manualWindow(operations.manual), legacyNgnFeePairs: legacyNgnFeePairs(pricing), inheritedPairs } });
        } catch (error) {
            return next(error);
        }
    }

    private async yellowCardRates(_req: Request, res: Response, next: NextFunction) {
        try {
            const results = await Promise.all(YELLOWCARD_FLOW_CURRENCIES.map((c) => ycRateService.explain(c).catch(() => null)));
            return this.sendSuccess(res, { currencies: results.filter(Boolean) });
        } catch (error) {
            return next(error);
        }
    }

    private async put(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const { rateMarkupPercent, additionalFeePercent, providerBaseFeePercent, tierDailyLimitNgn, pricing, operations } = req.body ?? {};

            // Each part of the settings belongs to a permission; saving one you don't hold is refused
            const needs: Array<[boolean, Permission[], string]> = [
                [pricing !== undefined || rateMarkupPercent !== undefined || additionalFeePercent !== undefined || providerBaseFeePercent !== undefined, ['pricing.api_currencies'], 'currency pricing'],
                [tierDailyLimitNgn !== undefined, ['pricing.daily_limits'], 'daily limits'],
                [operations?.manual !== undefined, ['pricing.manual_payments'], 'manual payments'],
                [operations?.pause !== undefined, ['platform_controls', 'dashboard.platform_controls'], 'platform controls'],
                [operations?.currencies !== undefined, ['platform_controls'], 'which currencies are on'],
                [operations?.approvals !== undefined, ['platform_controls'], 'the approval limit'],
                [operations?.liquidity !== undefined, ['profit_balances'], 'low-balance alerts'],
                [operations?.features !== undefined, ['platform_controls'], 'beta features'],
            ];
            for (const [touched, permissions, what] of needs) {
                if (!touched) continue;
                const ok = (await Promise.all(permissions.map((p) => allowed(res, p)))).some(Boolean);
                if (!ok) return next(errorResponseMessage.createError(403, `You can't change ${what}`, ErrorSeverity.HIGH));
            }

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
                const { ogateway, yellowcard, fincra } = providerBaseFeePercent;
                if (fincra !== undefined && !inRange(fincra, 0, 10)) {
                    return next(invalid('providerBaseFeePercent.fincra must be between 0 and 10'));
                }
                if (ogateway !== undefined && !inRange(ogateway, 0, 10)) {
                    return next(invalid('providerBaseFeePercent.ogateway must be between 0 and 10'));
                }
                if (yellowcard !== undefined && !inRange(yellowcard, 0, 10)) {
                    return next(invalid('providerBaseFeePercent.yellowcard must be between 0 and 10'));
                }
            }

            if (tierDailyLimitNgn !== undefined) {
                if (typeof tierDailyLimitNgn !== 'object' || tierDailyLimitNgn === null) {
                    return next(invalid('tierDailyLimitNgn must be an object'));
                }
                const { tier1, tier2 } = tierDailyLimitNgn;
                const MAX_LIMIT = 100_000_000_000; // ₦100bn
                if (tier1 !== undefined && !inRange(tier1, 0, MAX_LIMIT)) {
                    return next(invalid('Tier 1 daily limit must be a positive amount'));
                }
                if (tier2 !== undefined && !inRange(tier2, 0, MAX_LIMIT)) {
                    return next(invalid('Tier 2 daily limit must be a positive amount'));
                }
                const current = (await platformSettingsService.getSettings()).tierDailyLimitNgn;
                if ((tier1 ?? current?.tier1) > (tier2 ?? current?.tier2)) {
                    return next(invalid('The Tier 1 limit cannot be higher than the Tier 2 limit'));
                }
            }

            const updated = await platformSettingsService.updateSettings(
                { rateMarkupPercent, additionalFeePercent, providerBaseFeePercent, tierDailyLimitNgn, pricing, operations },
                user.id,
            );
            const saved = await platformSettingsService.getPricing();
            const savedOps = await platformSettingsService.getOperations();
            const inheritedPairs = await platformSettingsService.inheritedYellowCardPairs();
            return this.sendSuccess(res, { settings: { ...updated, pricing: saved, operations: savedOps, manualWindow: manualWindow(savedOps.manual), legacyNgnFeePairs: legacyNgnFeePairs(saved), inheritedPairs } });
        } catch (error) {
            if (error instanceof PricingError || error instanceof OperationsError) return next(invalid(error.message));
            return next(error);
        }
    }
}

export default new AdminPlatformSettingsController().router;
