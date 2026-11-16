import { Request } from 'express';
import webhookEventRepository, { type WebhookEventFilter } from '../repositories/webhook-event.repository';
import type { WebhookEvent } from '../types/entities';
import type { WebhookProvider } from '../types/enums';
import type { PageRequest, Paginated } from '../db/pagination';
import { WEBHOOK_STATUS } from '../common/constant';
import logger from '../utils/logger.utils';

/** Postgres jsonb can't store the NUL character; strip it rather than lose the event */
const stripNul = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null).replace(/\\u0000/g, ''));

/**
 * Records every inbound webhook verbatim before it is processed. Gives admins
 * forensic visibility and a single source of truth for replays.
 */
class WebhookEventService {
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
    }): Promise<WebhookEvent | null> {
        try {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(opts.req.headers || {})) {
                // Header values can be string | string[] | undefined
                if (typeof v === 'string') headers[k] = v;
                else if (Array.isArray(v)) headers[k] = v.join(',');
            }
            return await webhookEventRepository.create({
                provider: opts.provider,
                event: opts.event,
                externalId: opts.externalId,
                signature: opts.signature,
                signatureValid: opts.signatureValid,
                headers,
                payload: stripNul(opts.payload) ?? {},
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

    /** A new row for an admin replay of `original` */
    async recordReplay(original: WebhookEvent): Promise<WebhookEvent> {
        return webhookEventRepository.create({
            provider: original.provider,
            event: original.event,
            externalId: original.externalId,
            signature: original.signature,
            signatureValid: true, // the original signature was already verified
            headers: original.headers,
            payload: original.payload,
            receivedAt: new Date(),
            status: WEBHOOK_STATUS.RECEIVED,
            replayOf: original.id,
        });
    }

    async findById(id: string): Promise<WebhookEvent | undefined> {
        return webhookEventRepository.findById(id);
    }

    /** Newest first */
    async list(filter: WebhookEventFilter, page: PageRequest): Promise<Paginated<WebhookEvent>> {
        return webhookEventRepository.paginate(filter, page);
    }

    async markProcessed(id: string, opts: { txGroupId?: string } = {}): Promise<void> {
        try {
            await webhookEventRepository.update(id, {
                status: WEBHOOK_STATUS.PROCESSED,
                processedAt: new Date(),
                ...(opts.txGroupId ? { txGroupId: opts.txGroupId } : {}),
            });
        } catch (error) {
            logger.error('Failed to mark webhook processed', { id, error: error instanceof Error ? error.message : String(error) });
        }
    }

    async markFailed(id: string, error: unknown): Promise<void> {
        try {
            await webhookEventRepository.update(id, {
                status: WEBHOOK_STATUS.FAILED,
                processedAt: new Date(),
                error: error instanceof Error ? error.message : String(error),
            });
        } catch (innerError) {
            logger.error('Failed to mark webhook failed', { id, error: innerError instanceof Error ? innerError.message : String(innerError) });
        }
    }

    async markIgnored(id: string, reason: string): Promise<void> {
        try {
            await webhookEventRepository.update(id, { status: WEBHOOK_STATUS.IGNORED, processedAt: new Date(), error: reason });
        } catch (error) {
            logger.error('Failed to mark webhook ignored', { id, error: error instanceof Error ? error.message : String(error) });
        }
    }
}

const webhookEventService = new WebhookEventService();
export default webhookEventService;
export { WebhookEventService };
