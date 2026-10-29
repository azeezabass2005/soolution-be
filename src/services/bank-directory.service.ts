import yellowCardService from "./yellowcard.service";
import paystackService from "./paystack.service";
import WalletService from "./wallet.service";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { CURRENCY_COUNTRY } from "../common/payment-link.constants";
import logger from "../utils/logger.utils";

/**
 * One list of banks per currency, from whichever provider pays out there,
 * so bank names are picked rather than typed:
 *  - NGN: Paystack (withdrawals and NGN payouts)
 *  - YellowCard currencies (KES, ZAR, …): YellowCard's bank networks for that country
 *  - GHS: OGateway has no bank list we can read yet, so it stays free text
 *
 * `code` is what the provider needs to pay the account: Paystack's bank code,
 * or YellowCard's network id.
 */
export interface BankOption {
    code: string;
    name: string;
}

export interface BankDirectory {
    currency: string;
    provider: "paystack" | "yellowcard" | null;
    banks: BankOption[];
    /** Whether we can look up the account holder's name */
    canResolve: boolean;
}

const YC_BANK_CURRENCIES = ["KES", "XAF", "ZAR", "TZS", "UGX", "XOF", "RWF", "BWP", "ZMW", "MWK"];
const CACHE_MS = 60 * 60 * 1000;

const isBankNetwork = (n: any) => {
    const kind = String(n?.accountNumberType || n?.type || "").toLowerCase();
    return n?.status === "active" && kind === "bank";
};

class BankDirectoryService {
    private cache = new Map<string, { at: number; value: BankDirectory }>();
    private walletService = new WalletService();

    async list(rawCurrency: string): Promise<BankDirectory> {
        const currency = String(rawCurrency || "").toUpperCase();
        const cached = this.cache.get(currency);
        if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

        let value: BankDirectory;
        if (currency === "NGN") {
            const banks = await this.walletService.listBanks();
            value = {
                currency,
                provider: "paystack",
                banks: banks
                    .filter((b: any) => b.active !== false && b.code)
                    .map((b: any) => ({ code: String(b.code), name: String(b.name).trim() })),
                canResolve: true,
            };
        } else if (YC_BANK_CURRENCIES.includes(currency)) {
            const data: any = await yellowCardService.getNetworks(CURRENCY_COUNTRY[currency]);
            const networks: any[] = data?.networks || data || [];
            value = {
                currency,
                provider: "yellowcard",
                banks: networks.filter(isBankNetwork).map((n) => ({ code: String(n.id), name: String(n.name).trim() })),
                canResolve: true,
            };
        } else {
            value = { currency, provider: null, banks: [], canResolve: false };
        }

        value.banks = this.dedupeAndSort(value.banks);
        // Don't cache an empty list: it's more likely a provider hiccup than a country with no banks
        if (value.banks.length || !value.provider) this.cache.set(currency, { at: Date.now(), value });
        return value;
    }

    /** The account holder's name for this bank and account number */
    async resolve(rawCurrency: string, bankCode: string, accountNumber: string): Promise<{ accountName: string; accountNumber: string; bankCode: string }> {
        const currency = String(rawCurrency || "").toUpperCase();
        const number = String(accountNumber || "").replace(/\s+/g, "");
        if (!bankCode || !/^[0-9A-Za-z-]{4,40}$/.test(number)) {
            throw errorResponseMessage.createError(400, "Choose a bank and enter a valid account number", ErrorSeverity.LOW);
        }
        if (currency === "NGN" && !/^\d{10}$/.test(number)) {
            throw errorResponseMessage.createError(400, "Nigerian account numbers have 10 digits", ErrorSeverity.LOW);
        }

        const notFound = () => errorResponseMessage.createError(404, "We couldn't find that account. Check the number and bank.", ErrorSeverity.LOW);
        try {
            if (currency === "NGN") {
                const result: any = await paystackService.resolveAccountNumber(number, bankCode);
                if (!result?.account_name) throw notFound();
                return { accountName: result.account_name, accountNumber: number, bankCode };
            }
            if (YC_BANK_CURRENCIES.includes(currency)) {
                const result: any = await yellowCardService.resolveBankAccount(number, bankCode, CURRENCY_COUNTRY[currency]);
                const name = result?.accountName || result?.account_name || result?.name;
                if (!name) throw notFound();
                return { accountName: String(name), accountNumber: number, bankCode };
            }
        } catch (error: any) {
            if (error?.response_code) throw error;
            logger.warn("Bank account lookup failed", { currency, error: error?.response?.data?.message || error?.message });
            throw notFound();
        }
        throw errorResponseMessage.createError(400, `We can't look up ${currency} accounts. Enter the name on the account.`, ErrorSeverity.LOW);
    }

    private dedupeAndSort(banks: BankOption[]) {
        const seen = new Set<string>();
        return banks
            .filter((b) => b.name && !seen.has(b.code) && seen.add(b.code))
            .sort((a, b) => a.name.localeCompare(b.name));
    }
}

export default new BankDirectoryService();
