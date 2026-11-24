import platformSettingsService from "./platform-settings.service";
import userRepository from "../repositories/user.repository";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";

/**
 * Currencies a super admin has turned off, for everyone or for particular
 * users. A currency that's off can't be sent, received, put on a payment
 * link, paid through one, or exchanged into or out of. Naira is always on.
 */
class CurrencyAccessService {
    /** Every currency that's off for this user (everyone's plus their own) */
    async offFor(userId?: string | null): Promise<Set<string>> {
        const [{ currencies }, user] = await Promise.all([
            platformSettingsService.getOperations(),
            userId ? userRepository.findById(userId) : Promise.resolve(undefined),
        ]);
        return new Set([...currencies.off, ...((user?.disabledCurrencies as string[] | undefined) ?? [])]);
    }

    /** Throws (403) when any of these currencies is off for the user */
    async assertOn(userId: string, ...currencies: Array<string | null | undefined>): Promise<void> {
        const wanted = currencies.map((c) => String(c ?? "").toUpperCase()).filter((c) => c && c !== "NGN");
        if (!wanted.length) return;
        const off = await this.offFor(userId);
        const blocked = wanted.find((c) => off.has(c));
        if (blocked) {
            throw errorResponseMessage.createError(403, `${blocked} isn't available on your account right now. Contact support if you need it.`, ErrorSeverity.LOW, { code: "CURRENCY_OFF", currency: blocked });
        }
    }
}

export default new CurrencyAccessService();
