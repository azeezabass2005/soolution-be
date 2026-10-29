import { Request, Response, NextFunction } from "express";
import BaseController from "../base-controller";
import TransactionService from "../../../services/transaction.service";
import SmileId from "../../../services/smile-id.service";
import identityService from "../../../services/identity.service";
import yellowCardService from "../../../services/yellowcard.service";
import ogatewayService from "../../../services/ogateway.service";
import paystackService from "../../../services/paystack.service";
import WalletService from "../../../services/wallet.service";
import logger from "../../../utils/logger.utils";
import webhookEventService from "../../../services/webhook-event.service";
import { WEBHOOK_PROVIDER } from "../../../common/constant";

class WebhookController extends BaseController {

    transactionService: TransactionService;
    smileIdService: SmileId;
    walletService: WalletService;

    constructor () {
        super();
        this.transactionService = new TransactionService(["user"]);
        this.smileIdService = new SmileId();
        this.walletService = new WalletService();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.post("/smile-id-callback", this.smileIdCallback.bind(this));
        this.router.post("/yellowcard-callback", this.yellowCardCallback.bind(this));
        this.router.post("/ogateway", this.ogatewayCallback.bind(this));
        this.router.post("/paystack-callback", this.paystackCallback.bind(this));
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
        const eventId = stored?._id?.toString();

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

    /**
     * YellowCard webhook handler.
     * Verifies the webhook signature and delegates processing to the transaction service.
     */
    /**
     * OGateway webhook handler — handles collection and payout outcome events.
     * Signature: HMAC-SHA512 hex over raw body, header `x-ogateway-signature`.
     * Idempotency keyed on `reference_business` (= our internal sequenceId).
     */
    private async ogatewayCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
        const rawBody = (req as any).rawBody || JSON.stringify(req.body);
        const signature = (req.headers["x-ogateway-signature"] as string) || undefined;
        const externalId = req.body?.reference_business || req.body?.id;
        const eventName = req.body?.channel
            ? `${(req.body.channel as string).toLowerCase()}.${(req.body.status || 'event').toLowerCase()}`
            : (req.body?.status || 'event').toLowerCase();

        const signatureValid = ogatewayService.verifyWebhookSignature(rawBody, signature);

        const stored = await webhookEventService.record({
            provider: WEBHOOK_PROVIDER.OGATEWAY,
            req,
            payload: req.body,
            signature,
            signatureValid,
            event: eventName,
            externalId,
        });
        const eventId = stored?._id?.toString();

        if (!signature) {
            logger.warn("OGateway webhook: missing signature header");
            if (eventId) await webhookEventService.markFailed(eventId, 'missing signature');
            res.status(400).json({ error: "Missing signature" });
            return;
        }
        if (!signatureValid) {
            logger.error("OGateway webhook: invalid signature");
            if (eventId) await webhookEventService.markFailed(eventId, 'invalid signature');
            res.status(401).json({ error: "Invalid signature" });
            return;
        }

        logger.info("OGateway webhook received", { event: eventName, reference: externalId });
        res.status(200).json({ received: true });

        try {
            await this.transactionService.handleOGatewayWebhook(req.body);
            if (eventId) await webhookEventService.markProcessed(eventId);
        } catch (error: any) {
            logger.error("OGateway webhook processing error", { error: error?.message || error });
            if (eventId) await webhookEventService.markFailed(eventId, error);
        }
    }

    private async yellowCardCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
        const rawBody = (req as any).rawBody || JSON.stringify(req.body);
        const signature = (req.headers["x-yc-signature"] as string) || (req.headers["x-yellowcard-signature"] as string) || undefined;
        const event: string | undefined = req.body?.event;
        const externalId = req.body?.data?.sequenceId || req.body?.data?.id;

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
        const eventId = stored?._id?.toString();

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
     * Paystack webhook handler for wallet funding and withdrawal events.
     * Verifies HMAC SHA512 signature and processes:
     * - charge.success → wallet funding
     * - transfer.success → withdrawal completed
     * - transfer.failed / transfer.reversed → withdrawal failed, reverse balance
     */
    private async paystackCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
        const rawBody = (req as any).rawBody || JSON.stringify(req.body);
        const signature = req.headers["x-paystack-signature"] as string | undefined;
        const event: string | undefined = req.body?.event;
        const data = req.body?.data;
        const externalId = data?.reference || data?.id?.toString();

        // Verify signature first. We still record the event row so that
        // tampered/missing-signature attempts are visible to admins.
        const signatureValid = !!signature && paystackService.verifyWebhookSignature(rawBody, signature);

        const stored = await webhookEventService.record({
            provider: WEBHOOK_PROVIDER.PAYSTACK,
            req,
            payload: req.body,
            signature,
            signatureValid,
            event,
            externalId,
        });
        const eventId = stored?._id?.toString();

        if (!signature) {
            logger.warn("Paystack webhook: missing signature header");
            if (eventId) await webhookEventService.markFailed(eventId, 'missing signature');
            res.status(400).json({ error: "Missing signature" });
            return;
        }

        if (!signatureValid) {
            logger.error("Paystack webhook: invalid signature");
            if (eventId) await webhookEventService.markFailed(eventId, 'invalid signature');
            res.status(401).json({ error: "Invalid signature" });
            return;
        }

        // Respond 200 immediately to avoid timeouts. Processing continues async.
        res.status(200).json({ received: true });
        logger.info("Paystack webhook received", { event, reference: data?.reference });

        try {
            switch (event) {
                case "charge.success":
                    await this.walletService.processFunding(
                        data.reference,
                        data.amount,
                        data
                    );
                    break;
                case "transfer.success":
                    await this.walletService.processWithdrawalSuccess(
                        data.transfer_code,
                        data.reference
                    );
                    break;
                case "transfer.failed":
                case "transfer.reversed":
                    await this.walletService.processWithdrawalFailure(
                        data.transfer_code,
                        data.reference,
                        data.reason || `Transfer ${event.split('.')[1]}`
                    );
                    break;
                default:
                    logger.info("Paystack webhook: unhandled event", { event });
                    if (eventId) await webhookEventService.markIgnored(eventId, `unhandled event: ${event}`);
                    return;
            }
            if (eventId) await webhookEventService.markProcessed(eventId);
        } catch (error: any) {
            logger.error("Paystack webhook processing error", { error: error?.message || error });
            if (eventId) await webhookEventService.markFailed(eventId, error);
        }
    }
}

export default new WebhookController().router;