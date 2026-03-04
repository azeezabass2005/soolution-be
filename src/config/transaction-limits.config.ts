import { CurrencyCode } from "../models/interface";

/**
 * Transaction Limits Configuration
 * 
 * Defines minimum transaction amounts for each currency pair
 * All amounts are in the "from" currency
 */
export interface TransactionLimit {
    min: number;
}

export type CurrencyPair = `${CurrencyCode}->${CurrencyCode}`;

/**
 * Transaction limits per currency pair
 * Key format: "FROM_CURRENCY->TO_CURRENCY"
 * Values are in the FROM currency
 */
export const TRANSACTION_LIMITS: Partial<Record<CurrencyPair, TransactionLimit>> = {
    // NGN to other currencies
    'NGN->RMB': { min: 1000 },
    'NGN->GHS': { min: 1000 },
    'NGN->KES': { min: 1000 },
    'NGN->XAF': { min: 1000 },
    'NGN->NGN': { min: 1000 },

    // GHS to other currencies
    'GHS->RMB': { min: 50 },
    'GHS->NGN': { min: 50 },
    'GHS->KES': { min: 50 },
    'GHS->XAF': { min: 50 },
    'GHS->GHS': { min: 50 },

    // RMB to other currencies (if needed)
    'RMB->NGN': { min: 100 },
    'RMB->GHS': { min: 100 },
    'RMB->KES': { min: 100 },
    'RMB->XAF': { min: 100 },

    // KES to other currencies
    'KES->NGN': { min: 500 },
    'KES->GHS': { min: 500 },
    'KES->RMB': { min: 500 },
    'KES->XAF': { min: 500 },
    'KES->KES': { min: 500 },

    // XAF to other currencies
    'XAF->NGN': { min: 1000 },
    'XAF->GHS': { min: 1000 },
    'XAF->RMB': { min: 1000 },
    'XAF->KES': { min: 1000 },
    'XAF->XAF': { min: 1000 },

    // Other currency pairs (add as needed)
    'ZAR->NGN': { min: 100 },
    'ZAR->GHS': { min: 100 },
    'TZS->NGN': { min: 5000 },
    'TZS->GHS': { min: 5000 },
    'UGX->NGN': { min: 5000 },
    'UGX->GHS': { min: 5000 },
    'XOF->NGN': { min: 1000 },
    'XOF->GHS': { min: 1000 },
    'RWF->NGN': { min: 1000 },
    'RWF->GHS': { min: 1000 },
    'USDT->NGN': { min: 10 },
    'USDT->GHS': { min: 10 },
};

/**
 * Default transaction limits for currency pairs not explicitly defined
 */
export const DEFAULT_TRANSACTION_LIMITS: TransactionLimit = {
    min: 1.00
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

    return { isValid: true };
}
