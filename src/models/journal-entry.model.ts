import { Schema, model, Model, Document } from 'mongoose';
import paginate from 'mongoose-paginate-v2';
import {
    MODEL_NAME,
    JOURNAL_DIRECTION,
    JOURNAL_SOURCE,
} from '../common/constant';

export type JournalDirection = (typeof JOURNAL_DIRECTION)[keyof typeof JOURNAL_DIRECTION];
export type JournalSource = (typeof JOURNAL_SOURCE)[keyof typeof JOURNAL_SOURCE];

export interface IJournalEntry extends Document {
    // All legs of one logical posting share the same txGroupId so the system
    // can fetch them together and prove debit-credit balance.
    txGroupId: string;
    accountCode: string;
    account: Schema.Types.ObjectId | string;
    direction: JournalDirection;
    amount: number;
    currency: string;
    reference: string;
    source: JournalSource;
    description: string;
    externalRef?: { provider: string; id: string };
    metadata?: Record<string, any>;
    postedAt: Date;
    postedBy?: Schema.Types.ObjectId | string;
    // Set when this entry has been reversed by a later txGroupId, so the admin
    // ledger view can hide / strike-through reversed legs without losing them.
    reversedBy?: string;
}

const JournalEntrySchema = new Schema<IJournalEntry>(
    {
        txGroupId: { type: String, required: true, index: true },
        accountCode: { type: String, required: true, index: true },
        account: { type: Schema.Types.ObjectId, ref: MODEL_NAME.ACCOUNT, required: true, index: true },
        direction: { type: String, enum: Object.values(JOURNAL_DIRECTION), required: true },
        // Always positive — direction carries the sign semantically.
        amount: {
            type: Number,
            required: true,
            min: [0, 'Amount must be non-negative'],
            validate: {
                validator: (v: number) => Number.isFinite(v) && v >= 0,
                message: 'Amount must be a finite non-negative number',
            },
        },
        currency: { type: String, required: true, uppercase: true, trim: true },
        reference: { type: String, required: true, index: true },
        source: { type: String, enum: Object.values(JOURNAL_SOURCE), required: true, index: true },
        description: { type: String, required: true },
        externalRef: {
            provider: { type: String },
            id: { type: String },
        },
        metadata: { type: Schema.Types.Mixed },
        postedAt: { type: Date, required: true, default: Date.now, index: true },
        postedBy: { type: Schema.Types.ObjectId, ref: MODEL_NAME.USER },
        reversedBy: { type: String },
    },
    {
        toObject: { virtuals: true },
        toJSON: { virtuals: true },
        timestamps: true,
        collection: 'journal_entries',
    }
);

JournalEntrySchema.plugin(paginate);

// Look-ups by external provider event id (idempotency / replay tracing)
JournalEntrySchema.index({ 'externalRef.provider': 1, 'externalRef.id': 1 });
JournalEntrySchema.index({ accountCode: 1, postedAt: -1 });

const JournalEntry: Model<IJournalEntry> = model<IJournalEntry>(
    MODEL_NAME.JOURNAL_ENTRY,
    JournalEntrySchema
);
export default JournalEntry;
