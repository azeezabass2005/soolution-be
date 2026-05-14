import { Request } from 'express';
import DBService from '../utils/db.utils';
import WebhookEvent, { IWebhookEvent, WebhookProvider } from '../models/webhook-event.model';
import { WEBHOOK_STATUS } from '../common/constant';
import logger from '../utils/logger.utils';

/**
 * Records every inbound webhook verbatim before it is processed. Gives admins
 * forensic visibility and a single source of truth for replays.
 */
class WebhookEventService extends DBService<IWebhookEvent> {
    constructor() {
        super(WebhookEvent);
    }

    /**
     * Persist a freshly-arrived webhook. Always succeeds (failures only log)
     * so a recording problem can never block the actual processing path.
     */
    async record(opts: {
        provider: WebhookProvider;
        req: Request;
        payload: any;
        signature?: string;
        signatureValid: boolean;
        event?: string;
        externalId?: string;
    }): Promise<IWebhookEvent | null> {
        try {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(opts.req.headers || {})) {
                // Header values can be string | string[] | undefined
                if (typeof v === 'string') headers[k] = v;
                else if (Array.isArray(v)) headers[k] = v.join(',');
            }
            return await this.create({
                provider: opts.provider,
                event: opts.event,
                externalId: opts.externalId,
                signature: opts.signature,
                signatureValid: opts.signatureValid,
                headers,
                payload: opts.payload,
                receivedAt: new Date(),
                status: WEBHOOK_STATUS.RECEIVED,
            });
        } catch (error) {
            logger.error('Failed to record webhook event', {
                provider: opts.provider,
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    async markProcessed(id: string, opts: { txGroupId?: string } = {}): Promise<void> {
        try {
            await this.Model.updateOne(
                { _id: id },
                {
                    status: WEBHOOK_STATUS.PROCESSED,
                    processedAt: new Date(),
                    ...(opts.txGroupId ? { txGroupId: opts.txGroupId } : {}),
                }
            );
        } catch (error) {
            logger.error('Failed to mark webhook processed', {
                id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    async markFailed(id: string, error: unknown): Promise<void> {
        try {
            await this.Model.updateOne(
                { _id: id },
                {
                    status: WEBHOOK_STATUS.FAILED,
                    processedAt: new Date(),
                    error: error instanceof Error ? error.message : String(error),
                }
            );
        } catch (innerError) {
            logger.error('Failed to mark webhook failed', {
                id,
                error: innerError instanceof Error ? innerError.message : String(innerError),
            });
        }
    }

    async markIgnored(id: string, reason: string): Promise<void> {
        try {
            await this.Model.updateOne(
                { _id: id },
                {
                    status: WEBHOOK_STATUS.IGNORED,
                    processedAt: new Date(),
                    error: reason,
                }
            );
        } catch (error) {
            logger.error('Failed to mark webhook ignored', {
                id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

const webhookEventService = new WebhookEventService();
export default webhookEventService;
export { WebhookEventService };
