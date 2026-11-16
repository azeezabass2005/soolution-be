import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import webhookEventService from '../../../../services/webhook-event.service';
import errorResponseMessage from '../../../../common/messages/error-response-message';
import { WEBHOOK_PROVIDER } from '../../../../common/constant';
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
        this.transactionService = new TransactionService();
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
            const query = req.query;
            const result = await webhookEventService.list(
                {
                    provider: typeof query.provider === 'string' ? query.provider : undefined,
                    status: typeof query.status === 'string' ? query.status : undefined,
                    event: typeof query.event === 'string' ? query.event : undefined,
                    externalId: typeof query.externalId === 'string' ? query.externalId : undefined,
                    receivedFrom: typeof query.startDate === 'string' ? new Date(query.startDate) : undefined,
                    receivedTo: typeof query.endDate === 'string' ? new Date(query.endDate) : undefined,
                },
                { page: parseInt(query.page as string) || 1, limit: parseInt(query.limit as string) || 25 }
            );
            return this.sendSuccess(res, result);
        } catch (error) {
            return next(error);
        }
    }

    private async getOne(req: Request, res: Response, next: NextFunction) {
        try {
            const event = await webhookEventService.findById(req.params.id);
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
            const original = await webhookEventService.findById(req.params.id);
            if (!original) throw errorResponseMessage.resourceNotFound('Webhook event');

            // Insert a new row representing the replay attempt.
            const replay = await webhookEventService.recordReplay(original);
            const replayId = replay.id;

            try {
                await this.dispatchToHandler(original.provider, original.payload);
                await webhookEventService.markProcessed(replayId);
                logger.info('Webhook replayed', { originalId: original.id, replayId });
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
