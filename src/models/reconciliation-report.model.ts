import { Schema, model, Model, Document } from 'mongoose';
import paginate from 'mongoose-paginate-v2';
import { MODEL_NAME } from '../common/constant';

export interface IReconciliationReport extends Document {
    startedAt: Date;
    finishedAt?: Date;
    runBy?: Schema.Types.ObjectId | string; // admin userId; null for cron runs
    runMode: 'on_demand' | 'cron';
    walletProof: {
        walletsChecked: number;
        mismatches: Array<{
            walletId: string;
            userId?: string;
            expected: number;   // sum of journal entries
            actual: number;     // wallet.balance
            delta: number;
        }>;
    };
    accountProof: {
        accountsChecked: number;
        mismatches: Array<{
            code: string;
            expected: number;   // sum from journal
            actual: number;     // account.balance cache
            delta: number;
        }>;
    };
    ledgerProof: {
        txGroupsChecked: number;
        unbalancedGroups: Array<{
            txGroupId: string;
            debits: number;
            credits: number;
            delta: number;
        }>;
    };
    providerProof?: {
        paystack?: { internalCashBalance: number; providerBalance?: number; delta?: number; fetchedAt: Date; error?: string };
        yellowcard?: { internalFloat: number; providerBalance?: number; delta?: number; fetchedAt: Date; error?: string };
    };
    inFlight: {
        paystackTransfers: number;
        ycPayments: number;
        ycCollections: number;
    };
    suspense: {
        totalUnattributed: number;
        count: number;
    };
    status: 'clean' | 'mismatch' | 'error';
    notes?: string;
}

const ReconciliationReportSchema = new Schema<IReconciliationReport>(
    {
        startedAt: { type: Date, required: true, default: Date.now, index: true },
        finishedAt: { type: Date },
        runBy: { type: Schema.Types.ObjectId, ref: MODEL_NAME.USER },
        runMode: { type: String, enum: ['on_demand', 'cron'], required: true, default: 'on_demand' },
        walletProof: { type: Schema.Types.Mixed, required: true, default: { walletsChecked: 0, mismatches: [] } },
        accountProof: { type: Schema.Types.Mixed, required: true, default: { accountsChecked: 0, mismatches: [] } },
        ledgerProof: { type: Schema.Types.Mixed, required: true, default: { txGroupsChecked: 0, unbalancedGroups: [] } },
        providerProof: { type: Schema.Types.Mixed },
        inFlight: { type: Schema.Types.Mixed, required: true, default: { paystackTransfers: 0, ycPayments: 0, ycCollections: 0 } },
        suspense: { type: Schema.Types.Mixed, required: true, default: { totalUnattributed: 0, count: 0 } },
        status: { type: String, enum: ['clean', 'mismatch', 'error'], required: true, default: 'clean', index: true },
        notes: { type: String },
    },
    {
        toObject: { virtuals: true },
        toJSON: { virtuals: true },
        timestamps: true,
        collection: 'reconciliation_reports',
    }
);

ReconciliationReportSchema.plugin(paginate);

const ReconciliationReport: Model<IReconciliationReport> = model<IReconciliationReport>(
    MODEL_NAME.RECONCILIATION_REPORT,
    ReconciliationReportSchema
);
export default ReconciliationReport;
