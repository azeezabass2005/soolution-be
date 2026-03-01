import { CurrencyCode } from "../models/interface";

/**
 * Transaction Limits Configuration
 * 
 * Defines minimum and maximum transaction amounts for each currency pair
 * All amounts are in the "from" currency
 */
export interface TransactionLimit {
    min: number;
    max: number;
}

export type CurrencyPair = `${CurrencyCode}->${CurrencyCode}`;

/**
 * Transaction limits per currency pair
 * Key format: "FROM_CURRENCY->TO_CURRENCY"
 * Values are in the FROM currency
 */
export const TRANSACTION_LIMITS: Partial<Record<CurrencyPair, TransactionLimit>> = {
    // NGN to other currencies
    'NGN->RMB': { min: 1000, max: 10000000 },      // 1,000 NGN to 10M NGN
    'NGN->GHS': { min: 1000, max: 10000000 },
    'NGN->KES': { min: 1000, max: 10000000 },
    'NGN->XAF': { min: 1000, max: 10000000 },
    'NGN->NGN': { min: 1000, max: 10000000 },

    // GHS to other currencies
    'GHS->RMB': { min: 50, max: 500000 },         // 50 GHS to 500K GHS
    'GHS->NGN': { min: 50, max: 500000 },
    'GHS->KES': { min: 50, max: 500000 },
    'GHS->XAF': { min: 50, max: 500000 },
    'GHS->GHS': { min: 50, max: 500000 },

    // RMB to other currencies (if needed)
    'RMB->NGN': { min: 100, max: 1000000 },       // 100 RMB to 1M RMB
    'RMB->GHS': { min: 100, max: 1000000 },
    'RMB->KES': { min: 100, max: 1000000 },
    'RMB->XAF': { min: 100, max: 1000000 },

    // KES to other currencies
    'KES->NGN': { min: 500, max: 5000000 },       // 500 KES to 5M KES
    'KES->GHS': { min: 500, max: 5000000 },
    'KES->RMB': { min: 500, max: 5000000 },
    'KES->XAF': { min: 500, max: 5000000 },
    'KES->KES': { min: 500, max: 5000000 },

    // XAF to other currencies
    'XAF->NGN': { min: 1000, max: 10000000 },    // 1,000 XAF to 10M XAF
    'XAF->GHS': { min: 1000, max: 10000000 },
    'XAF->RMB': { min: 1000, max: 10000000 },
    'XAF->KES': { min: 1000, max: 10000000 },
    'XAF->XAF': { min: 1000, max: 10000000 },

    // Other currency pairs (add as needed)
    'ZAR->NGN': { min: 100, max: 1000000 },
    'ZAR->GHS': { min: 100, max: 1000000 },
    'TZS->NGN': { min: 5000, max: 50000000 },
    'TZS->GHS': { min: 5000, max: 50000000 },
    'UGX->NGN': { min: 5000, max: 50000000 },
    'UGX->GHS': { min: 5000, max: 50000000 },
    'XOF->NGN': { min: 1000, max: 10000000 },
    'XOF->GHS': { min: 1000, max: 10000000 },
    'RWF->NGN': { min: 1000, max: 10000000 },
    'RWF->GHS': { min: 1000, max: 10000000 },
    'USDT->NGN': { min: 10, max: 100000 },
    'USDT->GHS': { min: 10, max: 100000 },
};

/**
 * Default transaction limits for currency pairs not explicitly defined
 */
export const DEFAULT_TRANSACTION_LIMITS: TransactionLimit = {
    min: 1.00,
    max: 10000000
};

/**
 * Gets transaction limits for a currency pair
 * @param fromCurrency Source currency
 * @param toCurrency Target currency
 * @returns Transaction limit configuration
 */
export function getTransactionLimits(
    fromCurrency: CurrencyCode,
    toCurrency: CurrencyCode
): TransactionLimit {
    const pair: CurrencyPair = `${fromCurrency}->${toCurrency}` as CurrencyPair;
    return TRANSACTION_LIMITS[pair] || DEFAULT_TRANSACTION_LIMITS;
}

/**
 * Validates if an amount is within the allowed limits for a currency pair
 * Now validates against NGN 5,000 equivalent minimum across all currencies
 * @param amount Amount to validate
 * @param fromCurrency Source currency
 * @param toCurrency Target currency
 * @param ngnEquivalent Optional: NGN equivalent amount (if already calculated)
 * @returns Object with isValid flag and error message if invalid
 */
export function validateTransactionAmount(
    amount: number,
    fromCurrency: CurrencyCode,
    toCurrency: CurrencyCode,
    ngnEquivalent?: number
): { isValid: boolean; error?: string } {
    const MIN_NGN_EQUIVALENT = 5000; // Minimum NGN 5,000 equivalent
    const limits = getTransactionLimits(fromCurrency, toCurrency);

    // If NGN equivalent is provided, use it; otherwise use the amount directly if it's already NGN
    let amountInNGN = ngnEquivalent;
    if (amountInNGN === undefined) {
        if (fromCurrency === 'NGN') {
            amountInNGN = amount;
        } else {
            // If not provided and not NGN, we'll need to calculate it in the service layer
            // For now, use the old validation as fallback
            amountInNGN = amount; // Will be recalculated in service layer
        }
    }

    // Validate minimum: NGN 5,000 equivalent
    if (amountInNGN < MIN_NGN_EQUIVALENT) {
        return {
            isValid: false,
            error: `Minimum transaction amount is NGN ${MIN_NGN_EQUIVALENT.toLocaleString()} equivalent`
        };
    }

    // Validate maximum: use existing limits
    if (amount > limits.max) {
        return {
            isValid: false,
            error: `Maximum transaction amount is ${limits.max} ${fromCurrency}`
        };
    }

    return { isValid: true };
}
