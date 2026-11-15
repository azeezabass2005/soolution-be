import mongoose from "mongoose";
import DatabaseService from "../config/db.config";
import { PROVIDER_NAME_PATTERN } from "../utils/provider-names.utils";

/**
 * Rewrites customer-facing text saved before provider names were kept out of
 * it (refund reasons, verification reasons). Journal and webhook records are
 * for admins and stay as they are. Safe to run more than once.
 *
 *   npx tsc && node dist/scripts/scrub-provider-text.js
 */
const FIELDS: Array<{ collection: string; field: string; value: string }> = [
    { collection: "wallet_transactions", field: "failureReason", value: "Payment failed" },
    { collection: "verificationmodels", field: "reason", value: "Verification couldn't be completed" },
];

const scrubProviderText = async () => {
    try {
        await DatabaseService.getInstance().connect();
        const db = mongoose.connection.db!;
        const names = await db.listCollections().toArray();
        for (const { collection, field, value } of FIELDS) {
            if (!names.some((c) => c.name === collection)) {
                console.log(`${collection}: not found, skipped`);
                continue;
            }
            const result = await db.collection(collection).updateMany(
                { [field]: { $regex: PROVIDER_NAME_PATTERN.source, $options: "i" } },
                { $set: { [field]: value } },
            );
            console.log(`${collection}.${field}: ${result.modifiedCount} updated`);
        }
        process.exit(0);
    } catch (error) {
        console.error("Scrubbing provider names failed", error);
        process.exit(1);
    }
};

scrubProviderText();
