import yellowCardService from "./yellowcard.service";
import fincraService from "./fincra.service";
import WalletService from "./wallet.service";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { CURRENCY_COUNTRY } from "../common/payment-link.constants";
import logger from "../utils/logger.utils";
import { GHANA_BANKS } from "../common/ghana-banks.constants";

/**
 * One list of banks per currency, from whichever provider pays out there,
 * so bank names are picked rather than typed:
 *  - NGN: Fincra (withdrawals)
 *  - GHS: Fincra's Ghana banks (GHS sends)
 *  - YellowCard currencies (KES, ZAR, …): YellowCard's bank networks for that country
 *
 * `code` is what the provider needs to pay the account: Fincra's bank code,
 * or YellowCard's network id.
 */
export interface BankOption {
    code: string;
    name: string;
}

export interface BankDirectory {
    currency: string;
    banks: BankOption[];
    /** Whether we can look up the account holder's name */
    canResolve: boolean;
}

const YC_BANK_CURRENCIES = ["KES", "XAF", "ZAR", "TZS", "UGX", "XOF", "RWF", "BWP", "ZMW", "MWK"];
const CACHE_MS = 60 * 60 * 1000;

/** An active bank (not a mobile wallet), however YellowCard labels it */
const isBankNetwork = (n: any) => {
    const kinds = [n?.accountNumberType, n?.channelType, n?.type].map((k) => String(k || "").toLowerCase());
    return String(n?.status || "active").toLowerCase() === "active" && kinds.includes("bank");
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
                banks: banks
                    .filter((b: any) => b.active !== false && b.code)
                    .map((b: any) => ({ code: String(b.code), name: String(b.name).trim() })),
                canResolve: true,
            };
        } else if (currency === "GHS") {
            let banks: BankOption[] = [];
            try {
                banks = (await fincraService.listBanks("GH", "GHS", "bank_account")).map((b) => ({ code: b.code, name: b.name }));
            } catch (error: any) {
                logger.warn("Ghana bank list unavailable; using the built-in list", { error: error?.message });
            }
            // The provider's list can be empty (or down): people still pick from a list
            if (!banks.length) banks = GHANA_BANKS.map((name) => ({ code: name, name }));
            value = { currency, banks, canResolve: false };
        } else if (YC_BANK_CURRENCIES.includes(currency)) {
            let networks: any[] = [];
            try {
                const data: any = await yellowCardService.getNetworks(CURRENCY_COUNTRY[currency]);
                networks = Array.isArray(data?.networks) ? data.networks : Array.isArray(data) ? data : [];
            } catch (error: any) {
                logger.warn("YellowCard bank list unavailable", { currency, status: error?.response?.status, error: error?.response?.data?.message || error?.message });
                throw errorResponseMessage.createError(422, "We couldn't load the list of banks. Try again shortly.", ErrorSeverity.MEDIUM);
            }
            value = {
                currency,
                banks: networks.filter(isBankNetwork).map((n) => ({ code: String(n.id), name: String(n.name).trim() })),
                canResolve: true,
            };
        } else {
            value = { currency, banks: [], canResolve: false };
        }

        value.banks = this.dedupeAndSort(value.banks);
        // Don't cache an empty list: it's more likely a provider hiccup than a country with no banks
        if (value.banks.length || !value.canResolve) this.cache.set(currency, { at: Date.now(), value });
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
                const result = await fincraService.resolveAccount({ currency: "NGN", accountNumber: number, bankCode });
                if (!result?.accountName) throw notFound();
                return { accountName: result.accountName, accountNumber: number, bankCode };
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
