import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import errorResponseMessage, { ErrorSeverity } from '../../../../common/messages/error-response-message';
import transactionRepository from '../../../../repositories/transaction.repository';
import ghsConversionService from '../../../../services/ghs-conversion.service';
import fincraService from '../../../../services/fincra.service';
import { isUuid } from '../../../../repositories/utils';
import logger from '../../../../utils/logger.utils';

/**
 * Admin: GHS receipts at Fincra and their conversion to NGN. Lists each
 * receipt with how its conversion went (and Fincra's last error), shows the
 * Fincra balances, and converts a receipt on demand.
 */
class AdminConversionsController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.use(RoleMiddleware.isAdmin);
        this.router.get('/', this.list.bind(this));
        this.router.post('/:transactionId/convert', this.convert.bind(this));
    }

    private async list(req: Request, res: Response, next: NextFunction) {
        try {
            const limit = parseInt(req.query.limit as string) || 50;
            const [receipts, balances] = await Promise.all([
                transactionRepository.listFincraGhsReceipts(limit),
                fincraService.getBalances().catch((error: any) => {
                    logger.warn('Admin conversions: Fincra balances unavailable', { error: error?.message });
                    return null;
                }),
            ]);
            return this.sendSuccess(res, {
                autoConvert: ghsConversionService.enabled,
                balances: balances?.filter((b) => b.currency === 'GHS' || b.currency === 'NGN') ?? null,
                receipts,
            });
        } catch (error) {
            return next(error);
        }
    }

    private async convert(req: Request, res: Response, next: NextFunction) {
        try {
            const { transactionId } = req.params;
            if (!isUuid(transactionId)) throw errorResponseMessage.createError(400, 'Invalid transaction id', ErrorSeverity.LOW);
            let conversion;
            try {
                conversion = await ghsConversionService.convertNow(transactionId);
            } catch (error: any) {
                throw errorResponseMessage.createError(400, error?.message || "Couldn't convert this receipt", ErrorSeverity.LOW);
            }
            logger.info('Admin started a GHS conversion', { transactionId, admin: res.locals.user?.id, status: conversion?.status });
            return this.sendSuccess(res, { conversion });
        } catch (error) {
            return next(error);
        }
    }
}

export default new AdminConversionsController().router;
