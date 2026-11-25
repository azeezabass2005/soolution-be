import errorResponseMessage, { ErrorSeverity } from "./messages/error-response-message";

/** What a user sees when the money they want to move is part of a large receive still being checked */
export const HELD_FUNDS_MESSAGE = "Please hold on, naira will be available for withdrawal shortly, initial transaction checks are being conducted.";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What can leave a wallet now: its balance less any large receive still held for checks */
export const availableOf = (wallet: { balance?: unknown; heldBalance?: unknown }) =>
    round2(Math.max(0, (Number(wallet.balance) || 0) - (Number(wallet.heldBalance) || 0)));

/**
 * Throws when held money is what's missing: the balance covers `amount`, but
 * not without the part held for checks. Short in any case, the caller's own
 * "insufficient balance" check applies.
 */
export function assertNotHeld(wallet: { balance?: unknown; heldBalance?: unknown; currency?: unknown }, amount: number) {
    const balance = Number(wallet.balance) || 0;
    if (balance + 0.001 >= amount && availableOf(wallet) + 0.001 < amount) {
        throw errorResponseMessage.createError(400, HELD_FUNDS_MESSAGE, ErrorSeverity.LOW, {
            code: "FUNDS_HELD",
            currency: wallet.currency,
            required: round2(amount),
            available: availableOf(wallet),
            held: round2(Number(wallet.heldBalance) || 0),
        });
    }
}
