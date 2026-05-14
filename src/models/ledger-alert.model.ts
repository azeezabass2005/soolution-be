import { Schema, model, Model, Document } from 'mongoose';
import paginate from 'mongoose-paginate-v2';
import { MODEL_NAME } from '../common/constant';

export type LedgerAlertSeverity = 'warning' | 'critical';

export interface ILedgerAlert extends Document {
    severity: LedgerAlertSeverity;
    code: string;          // e.g. 'account_balance_drift', 'unbalanced_posting'
    accountCode?: string;
    txGroupId?: string;
    expected?: number;
    actual?: number;
    delta?: number;
    message: string;
    metadata?: Record<string, any>;
    acknowledgedAt?: Date;
    acknowledgedBy?: Schema.Types.ObjectId | string;
}

const LedgerAlertSchema = new Schema<ILedgerAlert>(
    {
        severity: { type: String, enum: ['warning', 'critical'], required: true, index: true },
        code: { type: String, required: true, index: true },
        accountCode: { type: String, index: true },
        txGroupId: { type: String, index: true },
        expected: { type: Number },
        actual: { type: Number },
        delta: { type: Number },
        message: { type: String, required: true },
        metadata: { type: Schema.Types.Mixed },
        acknowledgedAt: { type: Date },
        acknowledgedBy: { type: Schema.Types.ObjectId, ref: MODEL_NAME.USER },
    },
    {
        toObject: { virtuals: true },
        toJSON: { virtuals: true },
        timestamps: true,
        collection: 'ledger_alerts',
    }
);

LedgerAlertSchema.plugin(paginate);

const LedgerAlert: Model<ILedgerAlert> = model<ILedgerAlert>(
    MODEL_NAME.LEDGER_ALERT,
    LedgerAlertSchema
);
export default LedgerAlert;
