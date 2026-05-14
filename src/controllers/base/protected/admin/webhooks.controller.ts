import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import WebhookEvent from '../../../../models/webhook-event.model';
import webhookEventService from '../../../../services/webhook-event.service';
import errorResponseMessage from '../../../../common/messages/error-response-message';
import { WEBHOOK_PROVIDER, WEBHOOK_STATUS } from '../../../../common/constant';
import TransactionService from '../../../../services/transaction.service';
import WalletService from '../../../../services/wallet.service';
import logger from '../../../../utils/logger.utils';

/**
 * Admin endpoints for the webhook event log + replay.
 *
 * Replay re-runs the original processing path with the persisted payload and
 * inserts a new WebhookEvent row tagged `replayOf` so the audit trail is
 * preserved.
 */
class AdminWebhooksController extends BaseController {
    private transactionService: TransactionService;
    private walletService: WalletService;

    constructor() {
        super();
        this.transactionService = new TransactionService(['user']);
        this.walletService = new WalletService();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.use(RoleMiddleware.isAdmin);

        this.router.get('/', this.list.bind(this));
        this.router.get('/:id', this.getOne.bind(this));
        this.router.post('/:id/replay', this.replay.bind(this));
    }

    private async list(req: Request, res: Response, next: NextFunction) {
        try {
            const filter: any = {};
            if (typeof req.query.provider === 'string') filter.provider = req.query.provider;
            if (typeof req.query.status === 'string') filter.status = req.query.status;
            if (typeof req.query.event === 'string') filter.event = req.query.event;
            if (typeof req.query.externalId === 'string') filter.externalId = req.query.externalId;

            const dateRange: any = {};
            if (typeof req.query.startDate === 'string') dateRange.$gte = new Date(req.query.startDate);
            if (typeof req.query.endDate === 'string') dateRange.$lte = new Date(req.query.endDate);
            if (Object.keys(dateRange).length > 0) filter.receivedAt = dateRange;

            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 25;
            // @ts-ignore — paginate plugin
            const result = await WebhookEvent.paginate(filter, {
                page, limit, sort: { receivedAt: -1 },
                customLabels: {
                    totalDocs: 'itemsCount', docs: 'data', limit: 'perPage',
                    page: 'currentPage', nextPage: 'next', prevPage: 'prev',
                    totalPages: 'pageCount', pagingCounter: 'serialNumber', meta: 'paginator',
                },
            });
            return this.sendSuccess(res, result);
        } catch (error) {
            return next(error);
        }
    }

    private async getOne(req: Request, res: Response, next: NextFunction) {
        try {
            const event = await WebhookEvent.findById(req.params.id);
            if (!event) throw errorResponseMessage.resourceNotFound('Webhook event');
            return this.sendSuccess(res, { event });
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Re-run the same handler the webhook would have triggered, using the
     * stored payload. Idempotency at the journal layer protects against
     * double-processing (funding/withdrawal lookup by provider reference).
     */
    private async replay(req: Request, res: Response, next: NextFunction) {
        try {
            const original = await WebhookEvent.findById(req.params.id);
            if (!original) throw errorResponseMessage.resourceNotFound('Webhook event');

            // Insert a new row representing the replay attempt.
            const replay = await WebhookEvent.create({
                provider: original.provider,
                event: original.event,
                externalId: original.externalId,
                signature: original.signature,
                signatureValid: true, // we trust the original signature was already verified
                headers: original.headers,
                payload: original.payload,
                receivedAt: new Date(),
                status: WEBHOOK_STATUS.RECEIVED,
                replayOf: original._id,
            });
            const replayId = (replay._id as any).toString();

            try {
                await this.dispatchToHandler(original.provider, original.payload);
                await webhookEventService.markProcessed(replayId);
                logger.info('Webhook replayed', { originalId: original._id, replayId });
            } catch (replayError) {
                await webhookEventService.markFailed(replayId, replayError);
                throw replayError;
            }

            return this.sendSuccess(res, { replay });
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Route a stored payload back to the original processing path. Limited to
     * Paystack and YellowCard — Smile ID replays are intentionally not
     * supported here because they mutate user verification state.
     */
    private async dispatchToHandler(provider: string, payload: any): Promise<void> {
        if (provider === WEBHOOK_PROVIDER.YELLOWCARD) {
            await this.transactionService.handleYellowCardWebhook(payload);
            return;
        }
        if (provider === WEBHOOK_PROVIDER.PAYSTACK) {
            const event = payload?.event;
            const data = payload?.data;
            switch (event) {
                case 'charge.success':
                    await this.walletService.processFunding(data.reference, data.amount, data);
                    return;
                case 'transfer.success':
                    await this.walletService.processWithdrawalSuccess(data.transfer_code, data.reference);
                    return;
                case 'transfer.failed':
                case 'transfer.reversed':
                    await this.walletService.processWithdrawalFailure(
                        data.transfer_code,
                        data.reference,
                        data.reason || `Transfer ${event.split('.')[1]}`
                    );
                    return;
                default:
                    throw errorResponseMessage.payloadIncorrect(`Cannot replay Paystack event: ${event}`);
            }
        }
        throw errorResponseMessage.payloadIncorrect(`Replay not supported for provider: ${provider}`);
    }
}

export default new AdminWebhooksController().router;
