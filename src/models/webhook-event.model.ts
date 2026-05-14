import { Schema, model, Model, Document } from 'mongoose';
import paginate from 'mongoose-paginate-v2';
import { MODEL_NAME, WEBHOOK_PROVIDER, WEBHOOK_STATUS } from '../common/constant';

export type WebhookProvider = (typeof WEBHOOK_PROVIDER)[keyof typeof WEBHOOK_PROVIDER];
export type WebhookStatus = (typeof WEBHOOK_STATUS)[keyof typeof WEBHOOK_STATUS];

export interface IWebhookEvent extends Document {
    provider: WebhookProvider;
    event?: string;
    externalId?: string;       // provider's event id, if exposed
    signature?: string;
    signatureValid: boolean;
    headers: Record<string, string>;
    payload: any;
    receivedAt: Date;
    processedAt?: Date;
    status: WebhookStatus;
    error?: string;
    txGroupId?: string;        // link to journal entries posted by this event
    replayOf?: Schema.Types.ObjectId | string;
}

const WebhookEventSchema = new Schema<IWebhookEvent>(
    {
        provider: { type: String, enum: Object.values(WEBHOOK_PROVIDER), required: true, index: true },
        event: { type: String, index: true },
        externalId: { type: String, index: true },
        signature: { type: String },
        signatureValid: { type: Boolean, required: true, default: false },
        headers: { type: Schema.Types.Mixed, default: {} },
        payload: { type: Schema.Types.Mixed, required: true },
        receivedAt: { type: Date, required: true, default: Date.now, index: true },
        processedAt: { type: Date },
        status: { type: String, enum: Object.values(WEBHOOK_STATUS), required: true, default: WEBHOOK_STATUS.RECEIVED, index: true },
        error: { type: String },
        txGroupId: { type: String, index: true },
        replayOf: { type: Schema.Types.ObjectId, ref: MODEL_NAME.WEBHOOK_EVENT },
    },
    {
        toObject: { virtuals: true },
        toJSON: { virtuals: true },
        timestamps: true,
        collection: 'webhook_events',
    }
);

WebhookEventSchema.plugin(paginate);

// Sparse unique on (provider, externalId) lets the same provider re-emit the
// same event id safely (we dedupe at process time, but record both rows).
WebhookEventSchema.index({ provider: 1, status: 1, receivedAt: -1 });

const WebhookEvent: Model<IWebhookEvent> = model<IWebhookEvent>(
    MODEL_NAME.WEBHOOK_EVENT,
    WebhookEventSchema
);
export default WebhookEvent;
