import mongoose from "mongoose";
import FxQuote, { IFxQuote } from "../models/fx-quote.model";
import WalletTransaction from "../models/wallet-transaction.model";
import Wallet from "../models/wallet.model";
import fxRateService from "./fx-rate.service";
import ledgerService from "./ledger.service";
import WalletService from "./wallet.service";
import WalletTransactionService from "./wallet-transaction.service";
import PinService from "./pin.service";
import transactionLimitService from "./transaction-limit.service";
import AuditLogService from "./audit-log.service";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import {
    JOURNAL_DIRECTION,
    JOURNAL_SOURCE,
    WALLET_TRANSACTION_STATUS,
    WALLET_TRANSACTION_TYPE,
    userWalletAccountCode,
} from "../common/constant";
import { BASE_WALLET_CURRENCY, FX_QUOTE_TTL_MS, fxPositionCode, isWalletCurrency } from "../common/wallet.constants";
import logger from "../utils/logger.utils";

/** Smallest exchange, in NGN, so quotes aren't dominated by rounding */
export const MIN_EXCHANGE_NGN = 100;

const round2 = (n: number) => Math.round(n * 100) / 100;
// The user's side is rounded against them by at most a kobo/cent, never the platform's
const ceil2 = (n: number) => Math.ceil(Math.round(n * 1e6) / 1e4) / 100;
const floor2 = (n: number) => Math.floor(Math.round(n * 1e6) / 1e4) / 100;

export interface QuoteRequest {
    fromCurrency: unknown;
    toCurrency: unknown;
    amount: unknown;
    /** Which side `amount` is: what leaves the source wallet ("from", default) or what arrives ("to") */
    side?: unknown;
}

const auditLogService = new AuditLogService();

/**
 * Wallet-to-wallet exchanges between NGN and the other wallet currencies.
 *
 * A quote locks the rate for FX_QUOTE_TTL_MS and is single-use. Executing it
 * moves money between the user's two wallets and posts, per currency:
 *   USER_WALLET_FROM → FX_POSITION_FROM   and   FX_POSITION_TO → USER_WALLET_TO
 * so each currency balances on its own and FX_POSITION shows the platform's
 * net exposure.
 */
class FxExchangeService {
    private walletService = new WalletService();
    private walletTransactionService = new WalletTransactionService();
    private pinService = new PinService();

    async quote(userId: string, request: QuoteRequest) {
        await transactionLimitService.assertCanTransact(userId);
        const fromCurrency = String(request.fromCurrency ?? "").toUpperCase();
        const toCurrency = String(request.toCurrency ?? "").toUpperCase();
        const amount = Number(request.amount);
        const side = request.side === "to" ? "to" : "from";

        if (!isWalletCurrency(fromCurrency) || !isWalletCurrency(toCurrency)) {
            throw errorResponseMessage.createError(400, "Choose two wallet currencies to exchange between", ErrorSeverity.LOW);
        }
        if (fromCurrency === toCurrency) {
            throw errorResponseMessage.createError(400, "Choose two different wallets", ErrorSeverity.LOW);
        }
        if (fromCurrency !== BASE_WALLET_CURRENCY && toCurrency !== BASE_WALLET_CURRENCY) {
            throw errorResponseMessage.createError(400, "Exchanges go to or from your NGN wallet", ErrorSeverity.LOW);
        }
        if (!Number.isFinite(amount) || amount <= 0) {
            throw errorResponseMessage.createError(400, "Enter an amount greater than zero", ErrorSeverity.LOW);
        }

        const buying = fromCurrency === BASE_WALLET_CURRENCY;
        const foreign = buying ? toCurrency : fromCurrency;
        const { rate, providerRate, source } = await fxRateService.ngnPerUnit(foreign, buying ? "buy" : "sell");

        // rate = NGN per 1 foreign unit
        let fromAmount: number;
        let toAmount: number;
        if (buying) {
            if (side === "to") { toAmount = round2(amount); fromAmount = ceil2(toAmount * rate); }
            else { fromAmount = round2(amount); toAmount = floor2(fromAmount / rate); }
        } else {
            if (side === "from") { fromAmount = round2(amount); toAmount = floor2(fromAmount * rate); }
            else { toAmount = round2(amount); fromAmount = ceil2(toAmount / rate); }
        }

        const ngnSide = buying ? fromAmount : toAmount;
        if (ngnSide < MIN_EXCHANGE_NGN || fromAmount < 0.01 || toAmount < 0.01) {
            throw errorResponseMessage.createError(400, `The smallest exchange is ₦${MIN_EXCHANGE_NGN}`, ErrorSeverity.LOW);
        }

        const quote = await FxQuote.create({
            user: userId,
            fromCurrency,
            toCurrency,
            fromAmount,
            toAmount,
            rate,
            providerRate,
            rateSource: source,
            expiresAt: new Date(Date.now() + FX_QUOTE_TTL_MS),
        });
        return this.present(quote);
    }

    present(quote: IFxQuote) {
        return {
            id: String(quote._id),
            fromCurrency: quote.fromCurrency,
            toCurrency: quote.toCurrency,
            fromAmount: quote.fromAmount,
            toAmount: quote.toAmount,
            /** NGN per 1 unit of the non-NGN currency */
            rate: quote.rate,
            expiresAt: quote.expiresAt,
        };
    }

    async execute(userId: string, quoteId: unknown, pin: unknown) {
        if (typeof quoteId !== "string" || !mongoose.isValidObjectId(quoteId)) {
            throw errorResponseMessage.createError(400, "Get a rate before exchanging", ErrorSeverity.LOW);
        }
        if (typeof pin !== "string" || !pin) {
            throw errorResponseMessage.payloadIncorrect("Transaction PIN is required");
        }
        await transactionLimitService.assertCanTransact(userId);
        await this.pinService.verifyPin(userId, pin);

        const pending = await FxQuote.findOne({ _id: quoteId, user: userId }).lean();
        if (!pending) throw errorResponseMessage.resourceNotFound("Quote");
        if (pending.usedAt) {
            throw errorResponseMessage.createError(409, "This exchange has already been made", ErrorSeverity.LOW, { code: "QUOTE_USED" });
        }
        if (pending.expiresAt.getTime() <= Date.now()) {
            throw errorResponseMessage.createError(400, "This rate has expired. Get a new rate to continue.", ErrorSeverity.LOW, { code: "QUOTE_EXPIRED" });
        }

        const fromWallet = await this.walletService.findOne({ user: userId, currency: pending.fromCurrency });
        if (!fromWallet) {
            throw errorResponseMessage.createError(400, `You don't have a ${pending.fromCurrency} wallet`, ErrorSeverity.LOW);
        }
        // The destination wallet opens on the first exchange into it
        const toWallet = await this.walletService.getOrCreateWallet(userId, pending.toCurrency as any);
        await this.walletService.getOrCreateWallet(userId, pending.fromCurrency as any);

        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            // Claim the quote inside the transaction: an abort releases it again
            const quote = await FxQuote.findOneAndUpdate(
                { _id: quoteId, user: userId, usedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
                { $set: { usedAt: new Date() } },
                { new: true, session }
            );
            if (!quote) {
                throw errorResponseMessage.createError(409, "This rate is no longer available. Get a new rate to continue.", ErrorSeverity.LOW, { code: "QUOTE_EXPIRED" });
            }
            const { fromCurrency, toCurrency, fromAmount, toAmount, rate } = quote;

            const debited = await Wallet.findOneAndUpdate(
                { _id: fromWallet._id, status: "active", balance: { $gte: fromAmount } },
                { $inc: { balance: -fromAmount, ledgerBalance: -fromAmount } },
                { new: true, session }
            );
            if (!debited) {
                throw errorResponseMessage.createError(
                    400,
                    `Insufficient ${fromCurrency} balance for this exchange`,
                    ErrorSeverity.LOW,
                    { code: "INSUFFICIENT_BALANCE", currency: fromCurrency, required: fromAmount }
                );
            }
            const credited = await Wallet.findOneAndUpdate(
                { _id: toWallet._id, status: "active" },
                { $inc: { balance: toAmount, ledgerBalance: toAmount } },
                { new: true, session }
            );
            if (!credited) {
                throw errorResponseMessage.createError(400, `Your ${toCurrency} wallet is not active. Please contact support.`, ErrorSeverity.HIGH);
            }

            const reference = this.walletTransactionService.generateReference("FX");
            await ledgerService.post({
                perCurrency: true,
                legs: [
                    { accountCode: userWalletAccountCode(userId, fromCurrency), direction: JOURNAL_DIRECTION.DEBIT, amount: fromAmount },
                    { accountCode: fxPositionCode(fromCurrency), direction: JOURNAL_DIRECTION.CREDIT, amount: fromAmount },
                    { accountCode: fxPositionCode(toCurrency), direction: JOURNAL_DIRECTION.DEBIT, amount: toAmount },
                    { accountCode: userWalletAccountCode(userId, toCurrency), direction: JOURNAL_DIRECTION.CREDIT, amount: toAmount },
                ],
                source: JOURNAL_SOURCE.FX,
                reference,
                description: `Exchange ${fromAmount} ${fromCurrency} → ${toAmount} ${toCurrency}`,
                metadata: { quoteId, rate, providerRate: quote.providerRate, rateSource: quote.rateSource },
                session,
            });

            const shared = {
                user: userId,
                type: WALLET_TRANSACTION_TYPE.EXCHANGE,
                status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                rate,
                fxQuoteId: quote._id,
            };
            const [outRow, inRow] = await WalletTransaction.create([
                {
                    ...shared,
                    wallet: fromWallet._id,
                    amount: fromAmount,
                    currency: fromCurrency,
                    counterCurrency: toCurrency,
                    counterAmount: toAmount,
                    reference: `${reference}-OUT`,
                    balanceBefore: round2(debited.balance + fromAmount),
                    balanceAfter: debited.balance,
                    description: `Exchanged to ${toCurrency}`,
                },
                {
                    ...shared,
                    wallet: toWallet._id,
                    amount: toAmount,
                    currency: toCurrency,
                    counterCurrency: fromCurrency,
                    counterAmount: fromAmount,
                    reference: `${reference}-IN`,
                    balanceBefore: round2(credited.balance - toAmount),
                    balanceAfter: credited.balance,
                    description: `Exchanged from ${fromCurrency}`,
                },
            ], { session, ordered: true });

            await session.commitTransaction();
            logger.info("Wallet exchange completed", { userId, fromCurrency, toCurrency, fromAmount, toAmount, rate, reference });

            auditLogService
                .logAction(undefined, userId, "wallet_exchange", undefined, { fromCurrency, toCurrency, fromAmount, toAmount, rate, reference }, undefined, undefined, { quoteId })
                .catch((error) => logger.warn("Audit log write failed (wallet_exchange)", { reference, error: error?.message }));

            return {
                reference,
                fromAmount,
                toAmount,
                fromCurrency,
                toCurrency,
                rate,
                fromWallet: { currency: fromCurrency, balance: debited.balance },
                toWallet: { currency: toCurrency, balance: credited.balance },
                transactions: [outRow, inRow],
            };
        } catch (error) {
            if (session.inTransaction()) await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
    }
}

export default new FxExchangeService();
