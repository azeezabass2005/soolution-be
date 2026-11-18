import { Request, Response, NextFunction } from "express";
import BaseController from "../base-controller";
import TransactionService from "../../../services/transaction.service";
import SmileId from "../../../services/smile-id.service";
import identityService from "../../../services/identity.service";
import yellowCardService from "../../../services/yellowcard.service";
import fincraService from "../../../services/fincra.service";
import fincraWebhookService from "../../../services/fincra-webhook.service";
import logger from "../../../utils/logger.utils";
import webhookEventService from "../../../services/webhook-event.service";
import spotflowService from "../../../services/spotflow.service";
import { WEBHOOK_PROVIDER } from "../../../common/constant";

class WebhookController extends BaseController {

    transactionService: TransactionService;
    smileIdService: SmileId;

    constructor () {
        super();
        this.transactionService = new TransactionService();
        this.smileIdService = new SmileId();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.post("/smile-id-callback", this.smileIdCallback.bind(this));
        this.router.post("/yellowcard-callback", this.yellowCardCallback.bind(this));
        // Fincra: NGN deposits, virtual accounts, payouts and GHS payment links.
        // (Paystack and OGateway are no longer used.)
        this.router.post("/fincra", this.fincraCallback.bind(this));
        this.router.post("/spotflow", this.spotflowCallback.bind(this));
    }

    private async smileIdCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
        const webhookData = req.body;
        const signature = webhookData?.signature;
        const timestamp = webhookData?.timestamp;
        const externalId = webhookData?.SmileJobID;

        let isValidSignature = false;
        if (signature && timestamp) {
            try {
                isValidSignature = this.smileIdService.verifySignature(signature, timestamp);
            } catch (error: any) {
                logger.error("Smile ID webhook: signature verification threw", {
                    error: error?.message || String(error),
                });
            }
        }

        const stored = await webhookEventService.record({
            provider: WEBHOOK_PROVIDER.SMILE_ID,
            req,
            payload: webhookData,
            signature: typeof signature === 'string' ? signature : undefined,
            signatureValid: isValidSignature,
            event: webhookData?.ResultCode,
            externalId,
        });
        const eventId = stored?.id;

        try {
            if (!signature || !timestamp) {
                logger.warn("Smile ID webhook: missing signature or timestamp");
                if (eventId) await webhookEventService.markFailed(eventId, 'missing signature/timestamp');
                res.status(400).json({ error: "Invalid webhook payload - missing signature or timestamp" });
                return;
            }

            if (!isValidSignature) {
                logger.error("Smile ID webhook: invalid signature — rejecting");
                if (eventId) await webhookEventService.markFailed(eventId, 'invalid signature');
                res.status(401).json({ error: "Invalid signature" });
                return;
            }
            
            const outcome = await identityService.handleSmileResult(webhookData, "webhook");
            if (!outcome.handled) logger.warn("Smile ID webhook: not applied", { smileJobId: externalId, reason: outcome.reason });

            // Always respond with 200 to acknowledge receipt
            res.status(200).json({ received: true });
            if (eventId) await webhookEventService.markProcessed(eventId);
        } catch (error) {
            console.error("Error processing Smile ID webhook:", error);
            if (eventId) await webhookEventService.markFailed(eventId, error);
            // Still return 200 to prevent retries
            if (!res.headersSent) {
                res.status(200).json({ received: true, error: "Processing failed" });
            }
        }
    }

    private async yellowCardCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
        const rawBody = (req as any).rawBody || JSON.stringify(req.body);
        const signature = (req.headers["x-yc-signature"] as string) || (req.headers["x-yellowcard-signature"] as string) || undefined;
        const event: string | undefined = req.body?.event;
        const externalId = req.body?.sequenceId || req.body?.data?.sequenceId || req.body?.id || req.body?.data?.id;

        const signatureValid = !!signature && yellowCardService.verifyWebhookSignature(rawBody, signature);

        const stored = await webhookEventService.record({
            provider: WEBHOOK_PROVIDER.YELLOWCARD,
            req,
            payload: req.body,
            signature,
            signatureValid,
            event,
            externalId,
        });
        const eventId = stored?.id;

        if (!signature) {
            logger.warn("YellowCard webhook: missing signature header");
            if (eventId) await webhookEventService.markFailed(eventId, 'missing signature');
            res.status(400).json({ error: "Missing signature" });
            return;
        }
        if (!signatureValid) {
            logger.error("YellowCard webhook: invalid signature");
            if (eventId) await webhookEventService.markFailed(eventId, 'invalid signature');
            res.status(401).json({ error: "Invalid signature" });
            return;
        }

        logger.info("YellowCard webhook received", { event, sequenceId: externalId });
        res.status(200).json({ received: true });

        try {
            await this.transactionService.handleYellowCardWebhook(req.body);
            if (eventId) await webhookEventService.markProcessed(eventId);
        } catch (error: any) {
            logger.error("YellowCard webhook processing error", { error: error?.message || error });
            if (eventId) await webhookEventService.markFailed(eventId, error);
        }
    }
    /**
     * Fincra webhook. The signature (HMAC-SHA512 with the webhook key, header
     * `signature`) is checked before anything happens; every event is stored
     * first so rejected and failed deliveries are visible to admins and can be
     * replayed.
     */
    private async fincraCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
        const rawBody = (req as any).rawBody || JSON.stringify(req.body);
        const signature = (req.headers["signature"] as string | undefined) || undefined;
        const event: string | undefined = req.body?.event;
        const data = req.body?.data;
        const externalId = data?.customerReference || data?.reference || data?.id?.toString();

        const signatureValid = fincraService.verifyWebhookSignature(rawBody, req.body, signature);

        const stored = await webhookEventService.record({
            provider: WEBHOOK_PROVIDER.FINCRA,
            req,
            payload: req.body,
            signature,
            signatureValid,
            event,
            externalId,
        });
        const eventId = stored?.id;

        if (!signature) {
            logger.warn("Fincra webhook: missing signature header");
            if (eventId) await webhookEventService.markFailed(eventId, "missing signature");
            res.status(400).json({ error: "Missing signature" });
            return;
        }
        if (!signatureValid) {
            logger.error("Fincra webhook: invalid signature");
            if (eventId) await webhookEventService.markFailed(eventId, "invalid signature");
            res.status(401).json({ error: "Invalid signature" });
            return;
        }

        logger.info("Fincra webhook received", { event, reference: externalId });

        // Processed before answering: a 200 means it's done, and a failure
        // answers 500 so Fincra's auto-retry delivers it again. Every handler
        // is idempotent, so retries (even concurrent ones) act once.
        try {
            const result = await fincraWebhookService.handle(req.body);
            if (eventId) {
                if (result.outcome === "ignored") await webhookEventService.markIgnored(eventId, result.note || "ignored");
                else await webhookEventService.markProcessed(eventId);
            }
            res.status(200).json({ received: true });
        } catch (error: any) {
            logger.error("Fincra webhook processing error", { event, error: error?.message || error });
            if (eventId) await webhookEventService.markFailed(eventId, error);
            if (!res.headersSent) res.status(500).json({ received: false, error: "Processing failed; please retry" });
        }
    }

    /**
     * Spotflow: money paid into a one-time GHS account. Verified with the
     * webhook secret (Standard Webhooks), processed before answering, 500 on a
     * failure so Spotflow delivers it again. Crediting is idempotent.
     */
    private async spotflowCallback(req: Request, res: Response): Promise<void> {
        const rawBody = (req as any).rawBody || JSON.stringify(req.body);
        const event: string | undefined = req.body?.event;
        const data = req.body?.data;
        const signature = (req.headers["x-spotflow-signature"] as string | undefined) || undefined;
        const signatureValid = spotflowService.verifyWebhook(rawBody, req.headers as any);
        const stored = await webhookEventService.record({
            provider: WEBHOOK_PROVIDER.SPOTFLOW,
            req,
            payload: req.body,
            signature,
            signatureValid,
            event,
            externalId: (req.headers["webhook-id"] as string | undefined) || data?.id?.toString(),
        });
        const eventId = stored?.id;
        if (!signatureValid) {
            logger.error("Spotflow webhook: missing or invalid signature");
            if (eventId) await webhookEventService.markFailed(eventId, "invalid signature");
            res.status(401).json({ error: "Invalid signature" });
            return;
        }
        try {
            let result: { outcome: string; note?: string } = { outcome: "ignored", note: `event ${event}` };
            if (event === "account_credit_successful") result = await this.transactionService.handleSpotflowCredit(data);
            if (eventId) {
                if (result.outcome === "ignored") await webhookEventService.markIgnored(eventId, result.note || "ignored");
                else await webhookEventService.markProcessed(eventId);
            }
            res.status(200).json({ received: true });
        } catch (error: any) {
            logger.error("Spotflow webhook processing error", { event, error: error?.message || error });
            if (eventId) await webhookEventService.markFailed(eventId, error);
            if (!res.headersSent) res.status(500).json({ received: false, error: "Processing failed; please retry" });
        }
    }
}

export default new WebhookController().router;