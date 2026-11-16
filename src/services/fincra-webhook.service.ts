import WalletService from "./wallet.service";
import TransactionService from "./transaction.service";
import logger from "../utils/logger.utils";

export type FincraWebhookOutcome = "processed" | "ignored";

/**
 * Routes a Fincra webhook (already signature-checked) to what it affects.
 * Every handler is idempotent, so Fincra's retries and admin replays are safe.
 *
 *   collection.successful             → credit the NGN wallet behind the virtual account
 *   virtualaccount.approved / issued / declined / closed → the wallet's account number
 *   payout.successful / payout.failed → a withdrawal (WDR-…) or a GHS send
 *   charge.successful                 → a GHS payment-link payment (confirmed with Fincra first)
 */
class FincraWebhookService {
    private walletService = new WalletService();
    private transactionService = new TransactionService();

    async handle(payload: any): Promise<{ outcome: FincraWebhookOutcome; note?: string }> {
        const event = String(payload?.event || "").toLowerCase();
        const data = payload?.data ?? {};

        switch (event) {
            case "collection.successful": {
                await this.walletService.processFunding(data);
                return { outcome: "processed" };
            }
            case "collection.failed":
                logger.warn("Fincra deposit failed", { reference: data?.reference, reason: data?.reason });
                return { outcome: "ignored", note: "failed deposit: nothing to credit" };

            case "virtualaccount.approved":
            case "virtualaccount.issued":
            case "virtualaccount.changed":
            case "virtualaccount.declined":
            case "virtualaccount.closed": {
                const status = event.split(".")[1];
                const known = await this.walletService.handleVirtualAccountEvent({
                    ...data,
                    status: data?.status || (status === "issued" || status === "changed" ? "approved" : status),
                });
                return known ? { outcome: "processed" } : { outcome: "ignored", note: "unknown virtual account" };
            }

            case "payout.successful":
            case "payout.failed": {
                const status = data?.status || event.split(".")[1];
                const customerReference = String(data?.customerReference || "");
                // Withdrawals use our WDR- references; GHS sends their own
                if (customerReference.startsWith("WDR")) {
                    if (status === "successful") await this.walletService.processWithdrawalSuccess(String(data?.reference || ""), customerReference);
                    else await this.walletService.processWithdrawalFailure(String(data?.reference || ""), customerReference, data?.reason || "Transfer failed");
                    return { outcome: "processed" };
                }
                const known = await this.transactionService.handleFincraPayout({ ...data, customerReference, status });
                return known ? { outcome: "processed" } : { outcome: "ignored", note: "unknown payout reference" };
            }

            case "charge.successful":
            case "charge.failed": {
                // Our reference travels in the checkout's metadata
                const reference = String(data?.metadata?.reference || data?.merchantReference || "");
                if (!reference) return { outcome: "ignored", note: "charge without our reference" };
                const known = await this.transactionService.handleFincraCheckout(reference);
                return known ? { outcome: "processed" } : { outcome: "ignored", note: "unknown checkout reference" };
            }

            default:
                return { outcome: "ignored", note: `unhandled event: ${event || "none"}` };
        }
    }
}

export default new FincraWebhookService();
