import { paymentReasonOf } from "../common/payment-reasons";
import userNoticesService from "./user-notices.service";
import { canonicalBankKey } from '../common/ghana-banks.constants';
import transactionRepository, { type TransactionListFilter } from "../repositories/transaction.repository";
import transactionDetailRepository from "../repositories/transaction-detail.repository";
import userRepository from "../repositories/user.repository";
import walletTransactionRepository from "../repositories/wallet-transaction.repository";
import { withTransaction } from "../db/transaction";
import type { Executor } from "../db/client";
import type { PageRequest, Paginated } from "../db/pagination";
import type { Transaction, TransactionDetail, TransactionView } from "../types/entities";
import type { DetailType, TransactionStatus } from "../types/enums";
import {FileUploadFactory} from "./file-upload.factory";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import {DETAIL_TYPE, TRANSACTION_STATUS} from "../common/constant";
import RateUtils from "../utils/rate.utils";
import BankAccountDetailsService from "./bank-account-details.service";
import NotificationService from "../utils/notification.utils";
import config from "../config/env.config";
import { StorageService } from "./storage.service";
import logger from "../utils/logger.utils";
import crypto from "crypto";
import transactionStateMachine from "../utils/transaction-state-machine.utils";
import IdempotencyService from "./idempotency.service";
import AuditLogService from "./audit-log.service";
import { validateTransactionAmount, getTransactionLimits } from "../config/transaction-limits.config";
import yellowCardService, { YellowCardChannelType, YellowCardCountryConfig } from "./yellowcard.service";
import fincraService, { FINCRA_CHECKOUT_METHODS, FincraError, ghanaIntl, ghsMomoOperator } from "./fincra.service";
import spotflowService from "./spotflow.service";

/** How long a one-time GHS account takes payments (Spotflow's default) */
export const GHS_ACCOUNT_LIFETIME_MS = 30 * 60 * 1000;
/** Extra time before an unpaid one is closed, for transfers still on their way */
const GHS_ACCOUNT_GRACE_MS = 6 * 60 * 60 * 1000;
import ghsRateService, { GhsLimitError, type GhsPrice } from "./ghs-rate.service";
import ghsConversionService, { settledGhsFromCheckout } from "./ghs-conversion.service";
import transactionLimitService from "./transaction-limit.service";
import platformSettingsService from "./platform-settings.service";
import { isManualSendCurrency, manualWindow } from "../common/operations";

/** When it next opens, in Lagos time: "Monday 8am" */
const lagosOpening = (at: Date) =>
    at.toLocaleString("en-GB", { timeZone: "Africa/Lagos", weekday: "long", hour: "numeric", minute: "2-digit", hour12: true })
        .replace(":00", "").replace(" am", "am").replace(" pm", "pm");

/**
 * The terms for a manual send in `currency`: the admin's manual rate (naira
 * per unit), only while manual payments are open. Throws a user-facing error
 * outside the hours or when no manual rate is set.
 */
export async function manualSendTerms(currency: string, { needsRate = true }: { needsRate?: boolean } = {}): Promise<{ rate: number }> {
    if (!isManualSendCurrency(currency)) {
        throw errorResponseMessage.createError(400, `${currency} can only be sent instantly.`, ErrorSeverity.LOW, { code: "MANUAL_UNSUPPORTED" });
    }
    const ops = await platformSettingsService.getOperations();
    const window = manualWindow(ops.manual);
    if (!window.open) {
        throw errorResponseMessage.createError(
            400,
            `Manual payments run ${window.hours}.${window.opensAt ? ` They reopen ${lagosOpening(window.opensAt)}.` : ""} Use instant to pay now.`,
            ErrorSeverity.LOW,
            { code: "MANUAL_CLOSED", opensAt: window.opensAt?.toISOString() ?? null },
        );
    }
    const rate = ops.manual.rates[currency];
    if (needsRate && !(rate > 0)) {
        throw errorResponseMessage.createError(400, "Manual payments aren't available right now. Use instant instead.", ErrorSeverity.LOW, { code: "MANUAL_UNAVAILABLE" });
    }
    return { rate };
}
import {
    YELLOWCARD_STATUS,
    OGATEWAY_STATUS,
    OGATEWAY_CHANNELS,
    WALLET_STATUS,
    WALLET_TRANSACTION_TYPE,
    WALLET_TRANSACTION_STATUS,
    JOURNAL_DIRECTION,
    JOURNAL_SOURCE,
    SYSTEM_ACCOUNT_CODES,
    WEBHOOK_PROVIDER,
    userWalletAccountCode,
    fincraCashCode,
    spotflowCashCode,
    fincraPayoutInflightCode,
} from "../common/constant";
import WalletService from "./wallet.service";
import WalletTransactionService from "./wallet-transaction.service";
import walletSendService from "./wallet-send.service";
import { MANUAL_GHS_SEND, MANUAL_PAYOUT_CURRENCIES } from "../common/wallet.constants";
import PinService from "./pin.service";
import ledgerService from "./ledger.service";
import { pickYellowCardNetwork } from "../utils/momo-network.utils";
import identityService from "./identity.service";
import { CURRENCY_COUNTRY, ycCountryFor } from "../common/payment-link.constants";
import ycRateService, { type YcPrice } from "./yc-rate.service";
import currencyAccessService from "./currency-access.service";
import inboxService from "./inbox.service";
import payoutHoldsService from "./payout-holds.service";
import { limitProblem } from "../common/pricing";



/**
 * Stops a send or receive YellowCard can't route: the direction is off for
 * that country and currency, the channel type isn't offered, or the amount
 * (local currency) is outside its limits. A max of 0 means no maximum.
 */
const assertYellowCardRoute = (config: YellowCardCountryConfig, flow: "send" | "receive", channelType: YellowCardChannelType, amount: number) => {
    const where = `${config.currency} payments`;
    const ways = config.channels?.[flow] ?? config.channelTypes;
    if (!(flow === "send" ? config.send : config.receive) || !ways.includes(channelType)) {
        const other = ways.find((t) => t !== channelType);
        throw errorResponseMessage.createError(
            400,
            other
                ? `${channelType === "bank" ? "Bank" : "Mobile money"} isn't available for ${where} right now. Try ${other === "bank" ? "a bank account" : "mobile money"} instead.`
                : `Automatic ${flow === "send" ? "payments" : "collections"} aren't available for ${where} right now.`,
            ErrorSeverity.MEDIUM,
            { code: "CHANNEL_UNAVAILABLE", channelTypes: ways }
        );
    }
    const min = flow === "send" ? config.sendMin : config.receiveMin;
    const max = flow === "send" ? config.sendMax : config.receiveMax;
    const money = (value: number) => `${config.currency} ${value.toLocaleString("en-US")}`;
    if (min > 0 && amount < min) {
        throw errorResponseMessage.createError(400, `The minimum for ${where} is ${money(min)}.`, ErrorSeverity.LOW, { code: "AMOUNT_BELOW_MINIMUM", min });
    }
    if (max > 0 && amount > max) {
        throw errorResponseMessage.createError(400, `The maximum for ${where} is ${money(max)}.`, ErrorSeverity.LOW, { code: "AMOUNT_ABOVE_MAXIMUM", max });
    }
};

/**
 * A provider rejection in words a customer can act on. The provider's own
 * message stays in the logs; never send it to the client (it can name the provider).
 */
/** "Ama Mensah Owusu" → { firstName: "Ama", lastName: "Mensah Owusu" } */
const splitFullName = (full: string) => {
    const parts = (full || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { firstName: "Account", lastName: "Holder" };
    if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
    return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
};

const providerFailureMessage = (providerMessage: string, flow: "send" | "receive"): string => {
    const m = (providerMessage || "").toLowerCase();
    if (/channel|not supported|unsupported/.test(m)) {
        return "This payment method isn't available for that country right now. Please try a different one.";
    }
    if (/phone/.test(m) && /(sender|recipient)/.test(m)) {
        return "We couldn't use the phone number on your account for this transfer. Update your details and try again.";
    }
    if (/(minimum|maximum|limit|too (low|high|small|large)|amount)/.test(m)) {
        return "This amount is outside what's allowed for this route. Try a different amount.";
    }
    if (/(account|destination|source|network|bank|momo|wallet)/.test(m)) {
        return flow === "send"
            ? "The recipient's account details couldn't be used. Check the account number and provider, then try again."
            : "The payer's account details couldn't be used. Check the number and provider, then try again.";
    }
    return flow === "send"
        ? "We couldn't send this payment right now. Please try again in a few minutes."
        : "We couldn't start this payment request right now. Please try again in a few minutes.";
};

/** Create-request fields shared by the manual (bank transfer / Alipay) flows */
type ManualTransactionInput = {
    amount?: number;
    fromAmount?: number;
    fromCurrency?: string;
    paymentMethod?: DetailType;
    idempotencyKey?: string;
    pin?: string;
    walletCurrency?: string;
    // Bank transfer / mobile money
    toCurrency?: string;
    institutionType?: string;
    transactionType?: 'send' | 'receive';
    bankName?: string;
    accountNumber?: string;
    accountName?: string;
    momoNetwork?: string;
    momoNumber?: string;
    momoName?: string;
    // Alipay / WeChat
    platform?: string;
    alipayNo?: string;
    alipayName?: string;
};

/** What a YellowCard send needs to be paid out (kept on a held payout until it's approved) */
export interface YcSendContext {
    transactionId: string;
    walletTransactionId: string;
    walletTxRef: string;
    userId: string;
    totalDebit: number;
    feeAmount: number;
    walletDebit: number;
    walletCurrency: string;
    targetType: "bank" | "momo";
    destCountry: string;
    toCurrency: string;
    sequenceId: string;
    amount: number;
    destination: { accountName: string; accountNumber: string; accountType: string; networkId: string; country: string };
}

/** What a GHS send needs to be paid out by Fincra (kept on a held payout until it's approved) */
export interface GhsPayoutContext {
    transactionId: string;
    walletTransactionId: string;
    walletTxRef: string;
    userId: string;
    reference: string;
    amount: number;
    totalDebit: number;
    isMomo: boolean;
    senderName?: string;
    accountName: string;
    beneficiaryTarget: any;
}

class TransactionService {
    /** The admin's per-transaction GHS limits, as a 400 the user can act on */
    private async checkGhsLimits(direction: 'send' | 'receive', ghsAmount: number): Promise<void> {
        try {
            await ghsRateService.assertWithinLimits(direction, ghsAmount);
        } catch (err) {
            if (err instanceof GhsLimitError) {
                throw errorResponseMessage.createError(400, err.message, ErrorSeverity.LOW, { code: "TX_LIMIT" });
            }
            throw err;
        }
    }


    bankAccountDetailsService: BankAccountDetailsService;
    notificationService: NotificationService;
    storageService: StorageService;
    idempotencyService: IdempotencyService;
    auditLogService: AuditLogService;
    walletService: WalletService;
    walletTransactionService: WalletTransactionService;
    pinService: PinService;


    /**
     * Creates an instance of TransactionService
     * @constructor
     */
    constructor() {
        this.bankAccountDetailsService = new BankAccountDetailsService();
        this.notificationService = new NotificationService();
        this.storageService = new StorageService();
        this.idempotencyService = new IdempotencyService();
        this.auditLogService = new AuditLogService();
        this.walletService = new WalletService();
        this.walletTransactionService = new WalletTransactionService();
        this.pinService = new PinService();
    }

    private receiptUploadService = FileUploadFactory.getGeneralUploadService();


    private generateTransactionReference = () => {
        const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 22).toUpperCase();
        return `ALIPAY_TX_${randomPart}`;
    };

    private generateBankTransferTransactionReference = (currency: string) => {
        const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 22).toUpperCase();
        return `${currency}_TX_${randomPart}`;
    };

    public createBankTransferTransaction = async (
        transactionData: ManualTransactionInput,
        user: string,
        ipAddress?: string,
        userAgent?: string
    ) => {
        // A currency a super admin turned off (for everyone or this user) can't be used
        await currencyAccessService.assertOn(user, transactionData.fromCurrency, transactionData.toCurrency);
        const { amount, fromCurrency, toCurrency, paymentMethod, institutionType, bankName, accountNumber, accountName, momoNetwork, momoNumber, momoName, idempotencyKey, fromAmount, transactionType, pin } = transactionData;
        // A send paid from the destination currency's wallet: ops pays out directly
        const fromWallet = transactionType === 'send' && toCurrency
            ? this.resolveManualWallet(transactionData.walletCurrency, toCurrency)
            : null;

        if (!toCurrency) {
            throw errorResponseMessage.payloadIncorrect("Target currency (toCurrency) is required");
        }

        if (!fromCurrency) {
            throw errorResponseMessage.payloadIncorrect("Source currency (fromCurrency) is required");
        }

        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }

        // PIN authorization is required for SEND transactions only.
        // Receive transactions don't debit the wallet so the PIN gate doesn't apply.
        if (transactionType === 'send') {
            if (!pin) {
                throw errorResponseMessage.payloadIncorrect("Transaction PIN is required");
            }
            await this.pinService.verifyPin(user, pin);
        }

        // Manual is for sending GHS, KES and XAF (RMB has its own route); receiving is instant only
        if (transactionType !== 'send') {
            throw errorResponseMessage.createError(400, "Receiving is instant only. Use the instant receive option.", ErrorSeverity.LOW, { code: "MANUAL_UNSUPPORTED" });
        }
        if (toCurrency === 'RMB') {
            throw errorResponseMessage.createError(400, "RMB is sent through Alipay or WeChat.", ErrorSeverity.LOW);
        }
        // The admin's manual rate (naira per unit) and hours; paid from the destination wallet needs no rate
        const manual = await manualSendTerms(toCurrency, { needsRate: !fromWallet });

        // What the user pays in naira, always from the manual rate (never trusted from the client)
        const calculatedFromAmount = fromWallet
            ? Math.round(Number(fromAmount || amount * (manual.rate || 0)) * 100) / 100
            : Math.round(amount * manual.rate * 100) / 100;

        // Determine NGN equivalent for validation
        // For receive transactions: toCurrency is NGN, so amount is already the NGN equivalent
        // For send transactions: fromCurrency is NGN, so calculatedFromAmount/fromAmount is the NGN equivalent
        const isReceiveTransaction = toCurrency === 'NGN' && fromCurrency !== 'NGN';
        const ngnEquivalentForValidation = isReceiveTransaction ? amount : (calculatedFromAmount || fromAmount);

        // Validate amount against transaction limits (using NGN equivalent for minimum)
        const amountValidation = validateTransactionAmount(amount, fromCurrency as any, toCurrency as any, ngnEquivalentForValidation);
        if (!amountValidation.isValid) {
            throw errorResponseMessage.createError(
                400,
                amountValidation.error || "Transaction amount is outside allowed limits",
                ErrorSeverity.HIGH
            );
        }

        // Daily tier limit (throws when this would exceed today's limit)
        const { ngnValue: txNgnValue } = await transactionLimitService.assertAllowed(user, [
            { amount: calculatedFromAmount, currency: fromCurrency },
            { amount, currency: toCurrency },
        ]);
        if (fromWallet) await walletSendService.assertCanPay(user, fromWallet, Math.round(amount * 100) / 100);

        // Handle idempotency key if provided
        if (idempotencyKey) {
            const duplicate = await this.findDuplicate(idempotencyKey, user);
            if (duplicate) return duplicate;
        }

        const bankAccountDetails = fromWallet ? null : await this.bankAccountDetailsService.getCompanyDefault(fromCurrency);
        if(!fromWallet && !bankAccountDetails) {
            throw errorResponseMessage.resourceNotFound(`Bank details for ${fromCurrency}`)
        }

        const transaction = await transactionRepository.create({
            ...(manual.rate > 0 ? { lockedRate: manual.rate, lockedRateFromCurrency: fromCurrency, lockedRateToCurrency: toCurrency, lockedRateAt: new Date() } : {}),
            ngnValue: txNgnValue ?? undefined,
            user,
            reference: this.generateBankTransferTransactionReference(toCurrency),
            amount: Math.round(amount * 100) / 100, // Round to 2 decimal places
            fromCurrency,
            currency: toCurrency,
            detailType: (paymentMethod || DETAIL_TYPE.BANK_TRANSFER) as DetailType,
            status: TRANSACTION_STATUS.PENDING_INPUT as TransactionStatus,
            initiatedAt: new Date(),
        })

        // Update idempotency key with transaction ID if provided
        if (idempotencyKey) {
            await this.idempotencyService.updateKeyWithTransaction(idempotencyKey, transaction.id);
        }

        const transactionDetails = await transactionDetailRepository.create({
            transactionId: transaction.id,
            type: (paymentMethod || DETAIL_TYPE.BANK_TRANSFER) as DetailType,
            institutionType,
            ...(bankAccountDetails ? { bankAccountDetails: { ...bankAccountDetails } } : {}),
            ...(fromWallet ? { fundingCurrency: fromWallet, fundingAmount: transaction.amount, fundingFee: 0 } : {}),
            fromAmount: calculatedFromAmount, // Amount in source currency (what user sends)
            ...(institutionType === 'bank' ? {
                bankName,
                accountNumber,
                accountName,
            } : {
                momoNetwork,
                momoNumber,
                momoName,
            }),
        })

        if (fromWallet) {
            await this.holdManualPayoutFromWallet(transaction, user, `Payment to ${institutionType === 'bank' ? accountName : momoName || 'recipient'}`);
        }

        // The team sees every new manual payment straight away (in the app); the email follows once the user sends their receipt
        await inboxService.toTeam('transactions', {
            type: 'transaction.manual',
            title: `New manual ${transaction.currency} payment`,
            body: `${transaction.reference}: ${transaction.currency} ${Number(transaction.amount).toLocaleString('en-US')}${fromWallet ? ', paid from the customer\'s wallet' : ', waiting for the customer\'s receipt'}.`,
            link: '/dashboard/admin/transactions?status=in_progress',
            data: { transactionId: transaction.id },
        });

        // Send transaction initiated email to user
        try {
            const userObj = await userRepository.findById(transaction.user);
            if (userObj) {
                await this.notificationService.sendTransactionNotification(
                    userObj,
                    'payment_initiated',
                    {
                        amount: `${transaction.amount} ${transaction.currency}`,
                        reference: transaction.reference,
                        recipient: institutionType === 'bank' ? accountName : momoName || 'Recipient',
                        actionUrl: `${config.FRONTEND_URL}/dashboard/user/payments`,
                    }
                );
                logger.info('Transaction initiated email sent successfully', {
                    transactionId: transaction.id,
                    userId: userObj.id,
                    email: userObj.email,
                    reference: transaction.reference,
                    amount: `${transaction.amount} ${transaction.fromCurrency}`,
                    currency: transaction.currency
                });
            }
        } catch (error) {
            logger.error('Failed to send transaction initiated email', {
                transactionId: transaction.id,
                reference: transaction.reference,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            // Don't fail transaction creation if email fails
        }

        const created = fromWallet ? await transactionRepository.findById(transaction.id) : transaction;
        return { ...(created ?? transaction), details: { ...transactionDetails } }
    }

    /** null = pay by bank transfer (the default); otherwise the wallet currency, which must match the payout */
    private resolveManualWallet(requested: unknown, payoutCurrency: string): string | null {
        if (requested === undefined || requested === null || requested === "") return null;
        const currency = String(requested).toUpperCase();
        if (currency !== payoutCurrency || !(MANUAL_PAYOUT_CURRENCIES as readonly string[]).includes(currency)) {
            throw errorResponseMessage.createError(400, `${payoutCurrency} payments can be paid from your ${payoutCurrency} wallet or by bank transfer`, ErrorSeverity.LOW);
        }
        return currency;
    }

    /**
     * Take a manual send from the matching wallet and hand it straight to ops
     * (no bank transfer or receipt). If the hold fails (e.g. the balance was
     * spent meanwhile) the transaction is cancelled and the error rethrown.
     */
    private holdManualPayoutFromWallet = async (transaction: Transaction, userId: string, description: string, from?: { currency: string; amount: number }) => {
        try {
            await withTransaction(async (tx) => {
                await walletSendService.holdForManualPayout({
                    userId,
                    // The payout's own wallet by default; RMB is paid from the NGN wallet at the manual rate
                    currency: from?.currency ?? transaction.currency,
                    amount: from?.amount ?? transaction.amount,
                    transactionId: transaction.id,
                    reference: transaction.reference,
                    description,
                }, tx);
                await transactionRepository.update(transaction.id, { status: TRANSACTION_STATUS.AWAITING_CONFIRMATION as TransactionStatus }, tx);
            });
        } catch (error) {
            await transactionRepository.update(transaction.id, { status: TRANSACTION_STATUS.CANCELLED as TransactionStatus, cancelReason: "Wallet payment could not be taken" });
            throw error;
        }
    };

    /**
     * Admin rejects a manual send that hasn't been paid out. Money taken from a
     * wallet goes back to it; bank-transfer payments are refunded by ops as before.
     */
    public rejectManualTransaction = async (transactionId: string, reason: string, adminId?: string, ipAddress?: string, userAgent?: string) => {
        const trimmed = typeof reason === "string" ? reason.trim() : "";
        if (!trimmed) throw errorResponseMessage.payloadIncorrect("Give a reason for rejecting this payment");

        const transaction = await transactionRepository.findById(transactionId);
        if (!transaction) throw errorResponseMessage.resourceNotFound("Transaction");
        const manualTypes: string[] = [DETAIL_TYPE.ALIPAY, DETAIL_TYPE.WECHAT, DETAIL_TYPE.BANK_TRANSFER, DETAIL_TYPE.MOBILE_MONEY];
        if (!manualTypes.includes(transaction.detailType as string)) {
            throw errorResponseMessage.createError(400, "Only manual payments can be rejected here", ErrorSeverity.LOW);
        }
        transactionStateMachine.validateTransition(transaction.status, TRANSACTION_STATUS.CANCELLED);

        const oldStatus = transaction.status;
        const updated = await transactionRepository.updateIfStatus(transaction.id, oldStatus, {
            status: TRANSACTION_STATUS.CANCELLED as TransactionStatus,
            cancelReason: trimmed,
            failedAt: new Date(),
        });
        if (!updated) throw errorResponseMessage.createError(409, "This payment changed while you were reviewing it. Refresh and try again.", ErrorSeverity.LOW);

        const refunded = await walletSendService.refundManualPayout(transaction.id, trimmed);
        if (adminId) {
            this.auditLogService.logStatusChange(transactionId, adminId, oldStatus, TRANSACTION_STATUS.CANCELLED, ipAddress, userAgent)
                .catch((error: any) => logger.warn('Failed to log rejection', { transactionId, error: error?.message }));
        }
        logger.info("Manual transaction rejected", { transactionId, refunded, reason: trimmed });
        return { transaction: updated, refundedToWallet: refunded };
    };

    public createAlipayTransaction = async (transactionData: ManualTransactionInput, alipayQrCode: Express.Multer.File | { qrCodeUrl: string }, user: string, ipAddress?: string, userAgent?: string) =>  {
        await currencyAccessService.assertOn(user, 'RMB');
        const { amount, platform, alipayNo, alipayName, fromCurrency, paymentMethod, idempotencyKey, pin } = transactionData;
        // Paid from the user's wallet, never by transfer to us: the NGN wallet (at the admin's
        // manual RMB rate) unless they hold RMB and chose that wallet. Ops then pays out.
        const fromWallet: "NGN" | "RMB" = String(transactionData.walletCurrency || "").toUpperCase() === "RMB" ? "RMB" : "NGN";

        if (!fromCurrency) {
            throw errorResponseMessage.payloadIncorrect("Source currency (fromCurrency) is required");
        }

        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }

        // Alipay is always a send (debit) flow — PIN is required.
        if (!pin) {
            throw errorResponseMessage.payloadIncorrect("Transaction PIN is required");
        }
        await this.pinService.verifyPin(user, pin);

        // The admin's manual RMB rate (naira per yuan) and hours; paid from the RMB wallet needs no rate
        const manual = await manualSendTerms("RMB", { needsRate: fromWallet === "NGN" });
        const ngnEquivalent = manual.rate > 0
            ? Math.round(amount * manual.rate * 100) / 100
            : await new RateUtils(fromCurrency, "RMB").convertAmountReverse(amount);

        // Validate amount against transaction limits (using NGN equivalent for minimum)
        const amountValidation = validateTransactionAmount(amount, fromCurrency as any, "RMB", ngnEquivalent);
        if (!amountValidation.isValid) {
            throw errorResponseMessage.createError(
                400,
                amountValidation.error || "Transaction amount is outside allowed limits",
                ErrorSeverity.HIGH
            );
        }

        // Daily tier limit, valued from the source side (RMB isn't quoted in USD)
        const { ngnValue: txNgnValue } = await transactionLimitService.assertAllowed(user, [{ amount: ngnEquivalent, currency: fromCurrency }]);
        // What leaves the wallet: naira at the manual rate, or the yuan themselves
        const holdAmount = fromWallet === "NGN" ? ngnEquivalent : Math.round(amount * 100) / 100;
        await walletSendService.assertCanPay(user, fromWallet, holdAmount);

        // Handle idempotency key if provided
        if (idempotencyKey) {
            const duplicate = await this.findDuplicate(idempotencyKey, user);
            if (duplicate) return duplicate;
        }

        // No bank transfer to us: the money comes from the wallet
        // A saved beneficiary's QR code is reused; a new one is uploaded
        let qrCodeUrl: string;
        if ("qrCodeUrl" in alipayQrCode) {
            qrCodeUrl = alipayQrCode.qrCodeUrl;
        } else {
            const uploadResult = await this.receiptUploadService.uploadFile(alipayQrCode, {
                folder: 'qrcodes/',
                customFilename: `alipay_qrcode_${Date.now()}`,
                makePublic: true,
            });
            if(!uploadResult.success) {
                logger.error("Alipay QRCode upload to R2 failed", { error: uploadResult.error });
                throw errorResponseMessage.unableToComplete("Alipay Qrcode upload failed");
            }
            qrCodeUrl = uploadResult.file?.url!;
        }

        const transaction = await transactionRepository.create({
            ...(manual.rate > 0 ? { lockedRate: manual.rate, lockedRateFromCurrency: fromCurrency, lockedRateToCurrency: "RMB", lockedRateAt: new Date() } : {}),
            ngnValue: txNgnValue ?? undefined,
            user,
            reference: this.generateTransactionReference(),
            amount: Math.round(amount * 100) / 100, // Round to 2 decimal places
            fromCurrency,
            currency: "RMB",
            detailType: (paymentMethod || DETAIL_TYPE.ALIPAY) as DetailType,
            status: TRANSACTION_STATUS.PENDING_INPUT as TransactionStatus,
            initiatedAt: new Date(),
        })

        // Update idempotency key with transaction ID if provided
        if (idempotencyKey) {
            await this.idempotencyService.updateKeyWithTransaction(idempotencyKey, transaction.id);
        }

        const transactionDetails = await transactionDetailRepository.create({
            transactionId: transaction.id,
            type: (paymentMethod || DETAIL_TYPE.ALIPAY) as DetailType,
            alipayNo,
            alipayName,
            qrCodeUrl,
            fundingCurrency: fromWallet, fundingAmount: holdAmount, fundingFee: 0,
            ...(paymentMethod === 'alipay' ? { platform: platform as any } : {}),
        })

        await this.holdManualPayoutFromWallet(transaction, user, `${paymentMethod === 'wechat' ? 'WeChat' : 'Alipay'} payment to ${alipayName || 'recipient'}`, { currency: fromWallet, amount: holdAmount });

        // The team sees every new manual payment straight away (in the app)
        await inboxService.toTeam('transactions', {
            type: 'transaction.manual',
            title: `New manual ${transaction.currency} payment`,
            body: `${transaction.reference}: ${transaction.currency} ${Number(transaction.amount).toLocaleString('en-US')}, paid from the customer's ${fromWallet} wallet.`,
            link: '/dashboard/admin/transactions?status=in_progress',
            data: { transactionId: transaction.id },
        });

        // The user hears it's in hand: the money is held from their wallet and our team pays it out
        try {
            const owner = await userRepository.findById(transaction.user);
            if (owner) {
                await this.notificationService.sendNotification(owner as any, {
                    type: 'transaction.manual_started',
                    title: 'Your RMB payment is on its way',
                    message: `CNY ${Number(transaction.amount).toLocaleString('en-US')} to ${transactionDetails.alipayName || 'your recipient'} has been taken from your ${fromWallet} wallet and is being paid out. We'll tell you when it's done. Reference: ${transaction.reference}.`,
                    actionUrl: `${config.FRONTEND_URL}/dashboard/user/transactions`,
                    buttonText: 'View details',
                } as any);
            }
        } catch (error) {
            logger.warn('RMB payment notice failed', { transactionId: transaction.id, error: error instanceof Error ? error.message : String(error) });
        }

        const created = await transactionRepository.findById(transaction.id);
        return { ...(created ?? transaction), details: { ...transactionDetails } }
    }

    public uploadUserPaymentReceipt = async (transactionId: string, receipt: Express.Multer.File, userId?: string, ipAddress?: string, userAgent?: string) => {
        const uploadResult = await this.receiptUploadService.uploadFile(receipt as Express.Multer.File, {
            folder: 'pay_in/',
            customFilename: `pay_in_receipt${Date.now()}`,
            makePublic: true,
        });
        if(!uploadResult.success) {
            logger.error('Payment receipt upload failed', {
                error: uploadResult.error,
                transactionId,
                fileName: receipt.originalname,
                fileSize: receipt.size
            });
            throw errorResponseMessage.unableToComplete("Payment receipt upload failed");
        }

        if (!uploadResult.file?.url) {
            logger.error('Upload succeeded but no URL returned', {
                transactionId,
                fileKey: uploadResult.file?.key
            });
            throw errorResponseMessage.unableToComplete("Payment receipt upload failed - no URL returned");
        }

        const receiptUrl = uploadResult.file.url;
        logger.info('Payment receipt uploaded successfully', {
            transactionId,
            fileKey: uploadResult.file.key,
            fileUrl: receiptUrl,
            fileSize: uploadResult.file.size
        });

        // The receipt, the fromAmount and the status change commit together. The
        // row is locked (and must still be awaiting the receipt) so two uploads
        // can't both move it.
        const { transaction, details, oldStatus, newStatus } = await withTransaction(async (tx) => {
            const transaction = await transactionRepository.findByIdForUpdate(transactionId, TRANSACTION_STATUS.PENDING_INPUT as TransactionStatus, tx);
            if (!transaction) {
                throw errorResponseMessage.resourceNotFound("Transaction or transaction is not in a valid state for receipt upload");
            }

            if (!transaction.fromCurrency || !transaction.currency) {
                throw errorResponseMessage.createError(400, "Transaction currency information is missing", ErrorSeverity.HIGH);
            }

            if (!transaction.amount || transaction.amount <= 0) {
                throw errorResponseMessage.createError(400, "Transaction amount is invalid", ErrorSeverity.HIGH);
            }

            // Preserve fromAmount if already stored at transaction creation time (historically accurate).
            // Only compute it here for transaction types that don't store it during creation (e.g. Alipay).
            const existingDetails = await transactionDetailRepository.findByTransactionId(transaction.id, tx);
            const updateFields: { payInReceiptUrl: string; fromAmount?: number } = { payInReceiptUrl: receiptUrl };

            if (!existingDetails?.fromAmount) {
                // fromAmount not set at creation — compute from current rate as fallback
                const rateUtils = new RateUtils(transaction.fromCurrency, transaction.currency);
                let fromAmount = await rateUtils.convertAmountReverse(transaction.amount);
                fromAmount = Math.round(fromAmount * 100) / 100;
                updateFields.fromAmount = fromAmount;
            }

            const details = await transactionDetailRepository.updateByTransactionId(transaction.id, updateFields, tx);

            // Limits are enforced when the transaction is created, so a paid transaction goes straight to review
            const oldStatus = transaction.status;
            const newStatus = TRANSACTION_STATUS.AWAITING_CONFIRMATION as TransactionStatus;
            transactionStateMachine.validateTransition(oldStatus, newStatus);
            await transactionRepository.update(transaction.id, { status: newStatus }, tx);

            return { transaction, details, oldStatus, newStatus };
        });

        // Log status change and receipt upload (outside the transaction to avoid blocking)
        if (userId) {
            try {
                await Promise.all([
                    this.auditLogService.logStatusChange(transaction.id, userId, oldStatus, newStatus, ipAddress, userAgent),
                    this.auditLogService.logReceiptUpload(transaction.id, userId, 'pay_in', receiptUrl, ipAddress, userAgent)
                ]);
            } catch (error) {
                logger.warn('Failed to log audit events', { error, transactionId });
                // Don't fail if audit logging fails
            }
        }

        // Notify admins via both email and WhatsApp (don't fail if this fails)
        const isAlipayTransaction = transaction.currency === 'RMB';
        const transactionType = isAlipayTransaction ? 'RMB Payment' : `${transaction.currency} Payment`;
        const recipientInfo = isAlipayTransaction
            ? `${details?.alipayNo ? `Alipay No: ${details.alipayNo}\n` : ''}${details?.alipayName ? `Alipay Name: ${details.alipayName}` : ''}`
            : details?.institutionType === 'bank'
                ? `Bank: ${details.bankName}\nAccount Number: ${details.accountNumber}\nAccount Name: ${details.accountName}`
                : `Network: ${details?.momoNetwork}\nNumber: ${details?.momoNumber}\nName: ${details?.momoName}`;

        const attachments = [];
        const whatsappAttachments = [];

        if (isAlipayTransaction && details?.qrCodeUrl) {
            try {
                attachments.push({
                    filename: 'alipay_qrcode.png',
                    content: await this.storageService.downloadFile(details.qrCodeUrl),
                    contentType: 'image/png'
                });
                whatsappAttachments.push({
                    caption: 'Alipay QRCode',
                    url: details.qrCodeUrl,
                });
            } catch (error) {
                logger.warn('Failed to download Alipay QR code for notification', { error, transactionId });
                // Continue without QR code attachment
            }
        }

        try {
            attachments.push({
                filename: 'user_payment_receipt.png',
                content: await this.storageService.downloadFile(receiptUrl),
                contentType: 'image/png'
            });
            whatsappAttachments.push({
                caption: 'User Payment Receipt',
                url: receiptUrl,
            });
        } catch (error) {
            logger.warn('Failed to download receipt for notification, but receipt is uploaded', { error, transactionId, receiptUrl });
            // Continue without receipt attachment in notification, but receipt is already saved
        }

        // Send notifications (don't fail if this fails, receipt is already uploaded)
        try {
            await this.notificationService.notifyAdmins(
                config.ADMIN_EMAILS,
                {
                    title: `📱 New ${transactionType}`,
                    message: `A customer has initiated a new ${transaction.currency} payment and has paid. Check the payment receipt attached.\n${recipientInfo}`,
                    actionUrl: `${config.FRONTEND_URL}/dashboard/admin/transactions`,
                    buttonText: "Go to Transaction History",
                },
                config.ADMIN_PHONE_NUMBERS,
                attachments,
                whatsappAttachments,
            );
        } catch (error) {
            logger.error('Failed to send admin notifications, but receipt is uploaded', { error, transactionId });
            // Don't fail the whole operation if notifications fail
        }

        return { status: newStatus };
    }

    public uploadAdminPaymentReceipt = async (transactionId: string, receipt: Express.Multer.File, userId?: string, ipAddress?: string, userAgent?: string) => {
        const uploadResult = await this.receiptUploadService.uploadFile(receipt as Express.Multer.File, {
            folder: 'pay_out/',
            customFilename: `pay_out_receipt${Date.now()}`,
            makePublic: true,
        });
        if(!uploadResult.success) {
            logger.error("Admin payment receipt upload failed", { transactionId, error: uploadResult.error });
            throw errorResponseMessage.unableToComplete("Payment receipt upload failed");
        }

        // Fetch transaction and validate it exists
        const transaction = await transactionRepository.findById(transactionId);
        if (!transaction) {
            throw errorResponseMessage.resourceNotFound("Transaction");
        }

        // Validate transaction status - must be AWAITING_CONFIRMATION to complete
        if (transaction.status !== TRANSACTION_STATUS.AWAITING_CONFIRMATION) {
            throw errorResponseMessage.createError(
                400,
                `Cannot complete transaction. Transaction must be in ${TRANSACTION_STATUS.AWAITING_CONFIRMATION} status. Current status: ${transaction.status}`,
                ErrorSeverity.HIGH
            );
        }

        // Validate status transition before updating
        transactionStateMachine.validateTransition(transaction.status, TRANSACTION_STATUS.COMPLETED);

        const oldStatus = transaction.status;

        // Only the admin whose update moves it from AWAITING_CONFIRMATION completes it
        const completed = await withTransaction(async (tx) => {
            const updated = await transactionRepository.updateIfStatus(transaction.id, oldStatus, {
                status: TRANSACTION_STATUS.COMPLETED as TransactionStatus,
                completedAt: new Date(),
            }, tx);
            if (!updated) return false;
            await transactionDetailRepository.updateByTransactionId(transaction.id, { payOutReceiptUrl: uploadResult.file?.url }, tx);
            return true;
        });
        if (!completed) {
            throw errorResponseMessage.createError(409, "This payment changed while you were reviewing it. Refresh and try again.", ErrorSeverity.LOW);
        }

        // Paid from a wallet: the held money leaves the platform's FX position
        try {
            await walletSendService.completeManualPayout(transaction.id);
        } catch (error: any) {
            logger.error("CRITICAL: manual payout settlement posting failed", { transactionId, error: error?.message });
        }

        // Log status change and receipt upload
        if (userId) {
            try {
                await Promise.all([
                    this.auditLogService.logStatusChange(transaction.id, userId, oldStatus, TRANSACTION_STATUS.COMPLETED, ipAddress, userAgent),
                    this.auditLogService.logReceiptUpload(transaction.id, userId, 'pay_out', uploadResult.file?.url || '', ipAddress, userAgent)
                ]);
            } catch (error) {
                logger.warn('Failed to log audit events', { error, transactionId });
                // Don't fail if audit logging fails
            }
        }

        // Send transaction completed email and WhatsApp notification to user (with the payout receipt),
        // and mark it told so the notifier doesn't repeat it
        await userNoticesService.markTold("transaction", transaction.id, TRANSACTION_STATUS.COMPLETED);
        const user = await userRepository.findById(transaction.user);
        const details = await transactionDetailRepository.findByTransactionId(transaction.id);
        if (user) {
            try {
                await this.notificationService.sendTransactionNotification(
                    user,
                    'payment_completed',
                    {
                        amount: `${transaction.amount} ${transaction.currency}`,
                        reference: transaction.reference,
                        recipient: details?.alipayName || 'Recipient',
                        actionUrl: `${config.FRONTEND_URL}/dashboard/user/payments`,
                    },
                    [
                        {
                            filename: 'payment_receipt.png',
                            content: await this.storageService.downloadFile(uploadResult.file?.url!),
                            contentType: 'image/png'
                        }
                    ]
                );
                logger.info('Transaction completed email sent successfully', {
                    transactionId: transaction.id,
                    userId: user.id,
                    email: user.email,
                    reference: transaction.reference,
                    amount: `${transaction.amount} ${transaction.fromCurrency}`,
                    currency: transaction.currency
                });
            } catch (error) {
                logger.error('Failed to send transaction completed email', {
                    transactionId: transaction.id,
                    userId: user.id,
                    email: user.email,
                    reference: transaction.reference,
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                });
                // Don't fail transaction completion if email fails
            }
        }
    }

    public markAlipayTransactionAsCompleted = async (receipt: Express.Multer.File) =>  {
        /*
            TODO:
            - Upload the receipt file to r2
            - Save the URL to the database and change the status to completed
            - return the transaction to show success
         */
    }

    /**
     * Search transactions with flexible text matching
     * @param searchTerm - The term to search for
     * @param filters - Additional filters
     * @param options - Pagination and sorting options
     */
    // ============= YELLOWCARD AUTOMATIC PAYMENT METHODS =============

    private generateYellowCardSequenceId = () => {
        const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 22).toUpperCase();
        return `SP_TX_${randomPart}`;
    };

    /**
     * Create a YellowCard automatic payment transaction.
     * Step 1: Creates the transaction record and submits a collection request to YellowCard.
     * The collection collects local currency from the user. Once YellowCard confirms collection
     * via webhook, the disbursement (payment) is triggered automatically.
     */
    public createYellowCardTransaction = async (
        params: {
            amount: number;
            fromAmount?: number;
            fromCurrency: string;
            toCurrency: string;
            /** Ignored for KYC: the sender is built from the user's verified record */
            sender?: { country?: string };
            destination: {
                accountName: string;
                accountNumber: string;
                accountType: string;
                country: string;
                /** Provider the user chose, e.g. "Mpesa" or a bank name */
                network?: string;
            };
            idempotencyKey?: string;
            pin?: string;
            /** Pay from the NGN wallet (default) or the destination currency's wallet */
            walletCurrency?: string;
        },
        userId: string,
        ipAddress?: string,
        userAgent?: string
    ) => {
        // Why the money moves (YellowCard's list); required for sends
        const purposeOf = paymentReasonOf(params, { required: true });
        await currencyAccessService.assertOn(userId, params.toCurrency);
        const { amount, fromCurrency, toCurrency, destination, idempotencyKey, pin } = params;
        const walletCurrency = walletSendService.resolveWalletCurrency(params.walletCurrency, toCurrency);

        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }

        // YellowCard send is always an outbound debit — PIN is required.
        if (!pin) {
            throw errorResponseMessage.payloadIncorrect("Transaction PIN is required");
        }
        await this.pinService.verifyPin(userId, pin);

        // YellowCard's KYC for the sender, from our records. Refuses before any
        // money moves when the details aren't on file (production only).
        const kycPerson = await identityService.yellowCardPerson(userId);

        // ========== SERVER-SIDE RATE + FEE ==========
        // The pair's price (YellowCard's rate through USD, or ours, plus the
        // admin's buffer, fees and limits), so what the user was shown is what
        // they're charged. Client-supplied fromAmount is ignored.
        if (fromCurrency !== 'NGN') {
            throw errorResponseMessage.payloadIncorrect(`${toCurrency} sends are paid from your NGN wallet.`);
        }
        let price: YcPrice;
        try {
            price = await ycRateService.price('send', toCurrency, amount);
        } catch (err: any) {
            logger.error("YellowCard rate lookup failed during send", { fromCurrency, toCurrency, error: err?.message });
            throw errorResponseMessage.createError(400, `We couldn't get the ${fromCurrency}→${toCurrency} exchange rate right now. Please try again in a few minutes.`, ErrorSeverity.HIGH);
        }
        const limitIssue = limitProblem(price.limits, amount, toCurrency);
        if (limitIssue) throw errorResponseMessage.createError(400, limitIssue, ErrorSeverity.LOW, { code: "TX_LIMIT" });
        const { providerRate, userRate, feeAmount, feePercent, providerFeePercent } = price;
        const ngnAmount = price.subtotalNgn;
        if (!ngnAmount || ngnAmount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Source amount (fromAmount) must be a positive number");
        }
        const totalDebit = Math.round((ngnAmount + feeAmount) * 100) / 100;

        // Daily tier limit (throws when this would exceed today's limit)
        const { ngnValue: txNgnValue } = await transactionLimitService.assertAllowed(userId, [
            { amount: totalDebit, currency: fromCurrency },
            { amount, currency: toCurrency },
        ]);
        const markupPercent = price.markupPercent;

        // Check the paying wallet exists and has enough before calling YellowCard
        await walletSendService.assertCanPay(
            userId,
            walletCurrency,
            walletCurrency === 'NGN' ? totalDebit : Math.round((amount + walletSendService.walletFeeFor(amount, feePercent)) * 100) / 100,
        );

        // Handle idempotency
        if (idempotencyKey) {
            const duplicate = await this.findDuplicate(idempotencyKey, userId);
            if (duplicate) return duplicate;
        }

        // YellowCard routes by channel type: we say bank or momo plus the country
        // and currency, and it picks the best working channel itself
        // A CFA send names its country (e.g. XOF to Côte d'Ivoire); anything else uses the currency's own
        const destCountry = ycCountryFor(toCurrency, destination.country) || destination.country;
        destination.country = destCountry;
        const targetType = destination.accountType === 'bank' ? 'bank' : 'momo';

        let countryConfig: YellowCardCountryConfig;
        let networksData: any;
        try {
            [countryConfig, networksData] = await Promise.all([
                yellowCardService.getCountryConfig(destCountry, toCurrency),
                yellowCardService.getNetworks(destCountry),
            ]);
        } catch (error: any) {
            logger.error("Failed to fetch YellowCard country config/networks", { destCountry, toCurrency, error: error?.message });
            throw errorResponseMessage.createError(400, "Unable to fetch payment channels. Please try again.", ErrorSeverity.HIGH);
        }
        assertYellowCardRoute(countryConfig, "send", targetType, amount);

        const allNetworks = networksData?.networks || networksData || [];
        const network = pickYellowCardNetwork(allNetworks, { accountType: targetType, provider: destination.network });
        if (!network) {
            throw errorResponseMessage.createError(
                400,
                "Automatic payment is not available for this destination at the moment. Please try manual payment.",
                ErrorSeverity.MEDIUM
            );
        }

        logger.info("YellowCard route resolved", { destCountry, toCurrency, channelType: targetType, network: network.id });

        const sequenceId = this.generateYellowCardSequenceId();

        // ========== ATOMIC WALLET DEBIT ==========
        // The NGN figures are what the provider side of the ledger books; the
        // paying wallet (NGN, or the destination currency) is debited in its own currency.
        const { wallet, walletTransaction, walletDebit, walletFee } = await walletSendService.charge({
            userId,
            walletCurrency,
            destinationCurrency: toCurrency,
            destinationAmount: amount,
            ngnAmount,
            ngnFee: feeAmount,
            feePercent,
            providerAccountCode: SYSTEM_ACCOUNT_CODES.YC_FLOAT_NGN,
            source: JOURNAL_SOURCE.YC_SEND,
            reference: sequenceId,
            description: `YellowCard send — ${amount} ${toCurrency} to ${destination.accountName}`,
            externalRef: { provider: WEBHOOK_PROVIDER.YELLOWCARD, id: sequenceId },
            metadata: {
                destinationAmount: amount, destinationCurrency: toCurrency, destCountry,
                feeAmount, feePercent, providerFeePercent, markupPercent, providerRate, userRate,
            },
            walletTxDescription: `Transfer to ${destination.accountName} (${amount} ${toCurrency})`,
        });
        const walletTxRef = walletTransaction.reference;

        // Capture the locked FX rate so reports can replay the exact rate used.
        // lockedRate = userRate (markup already applied above).
        const lockedRate = userRate;

        // Create our internal transaction record
        let transaction: any;
        let transactionDetails: any;
        try {
            transaction = await transactionRepository.create({
                reason: purposeOf.reason, narration: purposeOf.narration,
                ngnValue: txNgnValue ?? undefined,
                user: userId,
                reference: sequenceId,
                amount: Math.round(amount * 100) / 100,
                fromCurrency,
                currency: toCurrency,
                detailType: DETAIL_TYPE.YELLOWCARD,
                status: TRANSACTION_STATUS.PENDING,
                initiatedAt: new Date(),
                lockedRate,
                lockedRateFromCurrency: 'NGN',
                lockedRateToCurrency: toCurrency,
                lockedRateAt: new Date(),
            });
        } catch (dbError: any) {
            logger.error("Failed to create YellowCard transaction record, refunding wallet", {
                error: dbError?.message || dbError,
                sequenceId,
            });
            // Refund wallet since we couldn't create the transaction
            await this.refundWallet(wallet.id, userId, totalDebit, walletTransaction.id, walletTxRef, "Transaction record creation failed", feeAmount);
            throw errorResponseMessage.createError(
                500,
                "We couldn't create this transaction. Please try again.",
                ErrorSeverity.CRITICAL
            );
        }

        // Link wallet transaction to the YellowCard transaction
        await walletTransactionRepository.update(walletTransaction.id, {
            paystackReference: sequenceId, // reuse field to link to YC transaction
            transactionId: transaction.id,
        });

        if (idempotencyKey) {
            await this.idempotencyService.updateKeyWithTransaction(idempotencyKey, transaction.id);
        }

        // Create transaction detail with YC-specific fields (channelId updated after successful submission)
        try {
            transactionDetails = await transactionDetailRepository.create({
                transactionId: transaction.id,
                type: DETAIL_TYPE.YELLOWCARD,
                ycSequenceId: sequenceId,
                ycNetworkId: network.id,
                ycStatus: YELLOWCARD_STATUS.PENDING,
                fromAmount: totalDebit,
                feeAmount,
                feePercent,
                fundingCurrency: walletCurrency,
                fundingAmount: walletDebit,
                fundingFee: walletFee,
                providerFeePercent,
                markupPercent,
                // What each unit cost us at YellowCard (our USD rate when set), for profit
                providerRate,
                accountName: destination.accountName,
                accountNumber: destination.accountNumber,
                institutionType: destination.accountType,
                country: destination.country,
                // Shown as the bank on receipts and transaction details
                ...(destination.accountType === "bank" ? { bankName: network.name } : { momoNetwork: network.name }),
            });
        } catch (dbError: any) {
            logger.error("Failed to create YellowCard transaction detail", {
                error: dbError?.message || dbError,
                transactionId: transaction.id,
                sequenceId,
            });
            throw errorResponseMessage.createError(
                500,
                "We couldn't create this transaction. Please try again.",
                ErrorSeverity.CRITICAL
            );
        }

        // Everything YellowCard needs, kept so the send can go now or once an admin approves it
        const ctx: YcSendContext = {
            transactionId: transaction.id,
            walletTransactionId: walletTransaction.id,
            walletTxRef,
            userId,
            totalDebit,
            feeAmount,
            walletDebit,
            walletCurrency,
            targetType,
            destCountry,
            toCurrency,
            sequenceId,
            amount,
            destination: {
                accountName: destination.accountName,
                accountNumber: destination.accountNumber,
                accountType: destination.accountType,
                networkId: network.id,
                country: destination.country,
            },
        };

        // Over the approval limit: the money stays held and YellowCard isn't asked until an admin approves
        if (await payoutHoldsService.needsApproval(userId, totalDebit)) {
            await transactionRepository.update(transaction.id, { status: TRANSACTION_STATUS.AWAITING_APPROVAL as TransactionStatus });
            await payoutHoldsService.hold({
                kind: "yellowcard_send", userId, transactionId: transaction.id, walletTransactionId: walletTransaction.id,
                reference: sequenceId, amountNgn: totalDebit, amount, currency: toCurrency,
                recipient: destination.accountName, payload: { ctx },
            });
            return { ...transaction, status: TRANSACTION_STATUS.AWAITING_APPROVAL, details: transactionDetails };
        }

        return this.submitYellowCardSend(ctx, kycPerson, transaction, transactionDetails);
    };

    /**
     * Asks YellowCard to pay out a send whose money is already taken. On
     * refusal the send fails and the wallet is refunded, then it throws.
     */
    public submitYellowCardSend = async (ctx: YcSendContext, kycPerson: any, transaction: any, transactionDetails: any) => {
        const { userId, totalDebit, feeAmount, walletDebit, walletCurrency, targetType, destCountry, toCurrency, sequenceId, amount, walletTxRef } = ctx;
        const destination = ctx.destination;
        const network = { id: ctx.destination.networkId };
        const walletTransaction = { id: ctx.walletTransactionId };
        const wallet = { id: undefined };

        let lastError: any = null;
        try {
            const paymentResponse = await yellowCardService.submitPaymentRequest({
                channelType: targetType,
                country: destCountry,
                currency: toCurrency,
                sequenceId,
                localAmount: amount,
                sender: kycPerson,
                destination: {
                    accountName: destination.accountName,
                    accountNumber: destination.accountNumber,
                    accountType: destination.accountType,
                    networkId: network.id,
                    country: destination.country,
                },
                reason: transaction.reason || "other",
                forceAccept: true,
            });

            // YellowCard says which channel it routed to
            await transactionDetailRepository.updateByTransactionId(transaction.id, {
                    ycChannelId: paymentResponse?.channelId,
                    ycPaymentId: paymentResponse?.id,
                    ycStatus: paymentResponse?.status || YELLOWCARD_STATUS.PROCESSING,
                    ycRawPayload: paymentResponse,
                }
            );

            await transactionRepository.update(transaction.id, {
                status: TRANSACTION_STATUS.PROCESSING,
            });

            // Mark wallet transaction as processing (payment submitted to YellowCard)
            await walletTransactionRepository.update(walletTransaction.id, {
                status: WALLET_TRANSACTION_STATUS.PROCESSING,
            });

            logger.info("YellowCard transaction created and payment submitted", {
                transactionId: transaction.id,
                sequenceId,
                channelType: targetType,
                channelId: paymentResponse?.channelId,
                ycPaymentId: paymentResponse?.id,
                walletCurrency,
                walletDebit,
            });

            return {
                ...transaction,
                status: TRANSACTION_STATUS.PROCESSING,
                details: {
                    ...transactionDetails,
                    ycChannelId: paymentResponse?.channelId,
                    ycPaymentId: paymentResponse?.id,
                    ycStatus: paymentResponse?.status || YELLOWCARD_STATUS.PROCESSING,
                },
            };
        } catch (error: any) {
            lastError = error;
        }

        // YellowCard rejected the payment — mark transaction as failed and REFUND wallet
        await transactionRepository.update(transaction.id, {
            status: TRANSACTION_STATUS.FAILED,
            failedAt: new Date(),
        });
        await transactionDetailRepository.updateByTransactionId(transaction.id, { ycStatus: YELLOWCARD_STATUS.FAILED }
        );

        // Refund wallet balance
        await this.refundWallet(wallet.id, userId, totalDebit, walletTransaction.id, walletTxRef, "Payment failed", feeAmount);

        const ycError = lastError?.ycError || lastError?.response?.data || lastError?.data;
        logger.error("YellowCard payment submission failed — wallet refunded", {
            transactionId: transaction.id,
            sequenceId,
            ycError,
            errorMessage: lastError?.message,
            refundedAmount: walletDebit,
            walletCurrency,
        });

        const ycMessage = ycError?.message || ycError?.code || lastError?.message || "Payment request failed";
        throw errorResponseMessage.createError(
            400,
            `${providerFailureMessage(ycMessage, "send")} Your wallet has not been charged.`,
            ErrorSeverity.HIGH,
            { code: "PROVIDER_REJECTED" }
        );
    };

    /**
     * Refund a failed YellowCard send to the wallet that paid for it. The
     * amounts come from the wallet transaction; `feeAmount` only matters for
     * rows created before multi-currency wallets. Never throws: a failed
     * refund is logged as CRITICAL for manual intervention.
     */
    private refundWallet = async (
        _walletId: any,
        _userId: string,
        _amount: number,
        walletTransactionId: any,
        originalRef: string,
        reason: string,
        feeAmount: number = 0,
    ) => {
        try {
            await walletSendService.refund(String(walletTransactionId), reason, {
                feeAmount,
                providerAccountCode: SYSTEM_ACCOUNT_CODES.YC_FLOAT_NGN,
                externalRef: { provider: WEBHOOK_PROVIDER.YELLOWCARD, id: originalRef },
            });
        } catch (refundError: any) {
            logger.error("CRITICAL: Wallet refund failed", { walletTransactionId, originalRef, error: refundError?.message });
        }
    };

    /**
     * Poll YellowCard for the current payment status and sync to local transaction.
     * Used when webhooks aren't available (e.g. localhost development).
     */
    public pollYellowCardStatus = async (transactionId: string) => {
        const transaction = await transactionRepository.findById(transactionId);
        if (!transaction) {
            throw errorResponseMessage.createError(404, "Transaction not found", ErrorSeverity.MEDIUM);
        }
        if (transaction.detailType !== DETAIL_TYPE.YELLOWCARD) {
            throw errorResponseMessage.createError(400, "This transaction's status can't be checked here.", ErrorSeverity.MEDIUM);
        }

        const detail = await transactionDetailRepository.findByTransactionId(transaction.id);
        if (!detail?.ycSequenceId) {
            throw errorResponseMessage.createError(400, "This transaction has no payment reference yet.", ErrorSeverity.MEDIUM);
        }

        // Lookup payment status from YellowCard
        let ycPayment: any;
        try {
            ycPayment = await yellowCardService.lookupPaymentBySequenceId(detail.ycSequenceId);
        } catch (error: any) {
            logger.error("Failed to poll YellowCard payment status", {
                transactionId,
                sequenceId: detail.ycSequenceId,
                error: error?.ycError || error?.message,
            });
            return {
                transaction: await transactionRepository.findViewById(transaction.id),
                ycStatus: detail.ycStatus || "unknown",
                message: "We couldn't check the latest status. We'll keep trying.",
            };
        }

        // YellowCard may return { status: "..." } directly or nested like { payment: { status: "..." } }
        const rawPayment = ycPayment?.payment || ycPayment?.data || ycPayment;
        const ycStatus = (rawPayment?.status || '')?.toLowerCase();

        logger.info("YellowCard poll: raw response", {
            transactionId,
            sequenceId: detail.ycSequenceId,
            ycPaymentTopLevelKeys: ycPayment ? Object.keys(ycPayment) : [],
            rawPaymentStatus: rawPayment?.status,
            ycStatusResolved: ycStatus,
            localStatus: transaction.status,
            ycPaymentRaw: JSON.stringify(ycPayment).substring(0, 800),
        });

        // Update local detail with latest YC data
        await transactionDetailRepository.update(detail.id, { ycRawPayload: ycPayment, ycStatus, ycPaymentId: ycPayment?.id || detail.ycPaymentId }
        );

        // Sync transaction status based on YC status
        // YellowCard uses "complete" (not "completed")
        logger.info("YellowCard poll: status sync check", {
            transactionId,
            ycStatus,
            localStatus: transaction.status,
            ycStatusIsComplete: ycStatus === "complete" || ycStatus === "completed",
            localIsNotCompleted: transaction.status !== TRANSACTION_STATUS.COMPLETED,
            TRANSACTION_STATUS_COMPLETED: TRANSACTION_STATUS.COMPLETED,
        });

        if ((ycStatus === "complete" || ycStatus === "completed") && transaction.status !== TRANSACTION_STATUS.COMPLETED) {
            // Only the caller that moves the status settles the wallet, so a
            // webhook and a status check arriving together can't both do it.
            const claimed = await this.claimStatus(transaction, TRANSACTION_STATUS.COMPLETED, { completedAt: new Date() });
            if (claimed) {
                logger.info("YellowCard poll: transaction completed", { transactionId });

                // Mark linked wallet transaction as successful
                const walletTx = await walletTransactionRepository.findByPaystackReference(transaction.reference, WALLET_TRANSACTION_TYPE.TRANSFER as "transfer");
                if (walletTx && walletTx.status !== WALLET_TRANSACTION_STATUS.SUCCESSFUL) {
                    await walletTransactionRepository.update(walletTx.id, {
                        status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                    });
                    await this.walletService.adjustLedgerBalance(walletTx.wallet, -walletTx.amount);
                    logger.info("Wallet transfer marked successful via poll", { walletTxId: walletTx.id, amount: walletTx.amount });
                }

                // The user hears about it from the notifier (user-notices.service), once
            } else {
                logger.info("YellowCard poll: already settled elsewhere", { transactionId, ycStatus });
            }
        } else if (ycStatus === "failed" || ycStatus === "expired" || ycStatus === "refunded" || ycStatus === "cancelled") {
            const newStatus = ycStatus === "cancelled" ? TRANSACTION_STATUS.CANCELLED : TRANSACTION_STATUS.FAILED;
            const claimed = await this.claimStatus(transaction, newStatus, newStatus === TRANSACTION_STATUS.FAILED ? { failedAt: new Date() } : {});
            if (claimed) {
                // Refund wallet on failure
                const walletTx = await walletTransactionRepository.findByPaystackReference(transaction.reference, WALLET_TRANSACTION_TYPE.TRANSFER as "transfer");
                if (walletTx && walletTx.status !== WALLET_TRANSACTION_STATUS.FAILED && walletTx.status !== WALLET_TRANSACTION_STATUS.REVERSED) {
                    const ycDetail = await transactionDetailRepository.findByTransactionId(transaction.id);
                    const fee = (ycDetail as any)?.feeAmount || 0;
                    await this.refundWallet(
                        walletTx.wallet,
                        walletTx.user,
                        walletTx.amount,
                        walletTx.id,
                        walletTx.reference,
                        `Payment ${ycStatus}`,
                        fee,
                    );
                    logger.info("Wallet refunded via poll", { walletTxId: walletTx.id, amount: walletTx.amount });
                }

                logger.info("YellowCard poll: transaction failed/cancelled", { transactionId, ycStatus });
            }
        } else {
            logger.info("YellowCard poll: no status change needed", {
                transactionId,
                ycStatus,
                localStatus: transaction.status,
            });
        }

        const updatedTransaction = await transactionRepository.findViewById(transactionId);
        logger.info("YellowCard poll: final transaction status", {
            transactionId,
            finalStatus: updatedTransaction?.status,
        });
        return {
            transaction: updatedTransaction,
            ycStatus,
            ycPayment,
        };
    };

    // ===================== YELLOWCARD COLLECTION (RECEIVE) =====================

    /**
     * Create a YellowCard collection transaction (receive money).
     * Sender pays in foreign currency → YellowCard collects → NGN credited to user's wallet.
     */
    public createYellowCardCollectionTransaction = async (
        params: {
            amount: number;          // Amount in foreign currency (what sender pays)
            fromAmount?: number;     // NGN equivalent (what user receives)
            fromCurrency: string;    // Foreign currency (KES, GHS, XAF)
            toCurrency: string;      // NGN (user's wallet currency)
            /**
             * Only `country` is used: where the payer pays from (it picks the
             * YellowCard channel). The KYC recipient is our user, from our records.
             */
            sender?: { country?: string };
            destination?: {
                accountName?: string;
                accountNumber?: string;
                accountType?: string;
                country?: string;
                /** Provider the payer pays with, e.g. "Mpesa", or a YellowCard network id */
                network?: string;
                /** Readable bank name when `network` is a picked bank's id */
                bankName?: string;
            };
            idempotencyKey?: string;
            /** Set when the payer filled in a payment link */
            paymentLinkId?: string;
            /** The payer's name and email from the payment link form */
            payer?: { name?: string; email?: string; phone?: string };
            /** The user paying in from their own mobile money or bank (a top-up), not a payer */
            topUp?: boolean;
        },
        userId: string,
    ) => {
        // Why the money moves (YellowCard's list); optional for receives
        const purposeOf = paymentReasonOf(params, { required: false });
        await currencyAccessService.assertOn(userId, params.fromCurrency);
        const { amount, fromCurrency, toCurrency, destination, idempotencyKey, paymentLinkId } = params;
        const topUp = params.topUp === true && !paymentLinkId;

        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }

        // YellowCard's KYC for the recipient (our user), from our records.
        // Refuses before anything is created when details are missing (production only).
        const kycPerson = await identityService.yellowCardPerson(userId);

        // Server-side rate + fee for the collection, from the pair's price
        // (YellowCard's rate through USD, or ours, with the admin's buffer,
        // fees and limits). The user receives `gross − fee` NGN.
        if (toCurrency !== 'NGN') {
            throw errorResponseMessage.payloadIncorrect(`${fromCurrency} payments are credited to your NGN wallet.`);
        }
        let price: YcPrice;
        try {
            price = await ycRateService.price('receive', fromCurrency, amount);
        } catch (err: any) {
            logger.error("YellowCard rate lookup failed during collection", { fromCurrency, toCurrency, error: err?.message });
            throw errorResponseMessage.createError(400, `We couldn't get the ${fromCurrency}→${toCurrency} exchange rate right now. Please try again in a few minutes.`, ErrorSeverity.HIGH);
        }
        const limitIssue = limitProblem(price.limits, amount, fromCurrency);
        if (limitIssue) throw errorResponseMessage.createError(400, limitIssue, ErrorSeverity.LOW, { code: "TX_LIMIT" });
        const { providerRate, userRate } = price;
        const grossNgn = price.subtotalNgn;

        // Daily tier limit (throws when this would exceed today's limit)
        const { ngnValue: txNgnValue } = await transactionLimitService.assertAllowed(userId, [
            { amount, currency: fromCurrency },
            { amount: grossNgn, currency: toCurrency },
        ]);

        const { feeAmount, feePercent, providerFeePercent } = price;
        const ngnAmount = price.totalNgn;
        if (ngnAmount <= 0) {
            throw errorResponseMessage.createError(400, "Fee exceeds the converted amount. Please increase the amount.", ErrorSeverity.MEDIUM);
        }
        const markupPercent = price.markupPercent;

        // Handle idempotency
        if (idempotencyKey) {
            const duplicate = await this.findDuplicate(idempotencyKey, userId);
            if (duplicate) return duplicate;
        }

        // Where the payer pays from. YellowCard routes by channel type (bank or
        // momo) plus country and currency, picking the best working channel itself.
        const senderCountry = ycCountryFor(fromCurrency, params.sender?.country) || params.sender?.country || CURRENCY_COUNTRY[fromCurrency];
        const targetType = destination?.accountType === 'bank' ? 'bank' : 'momo';

        let countryConfig: YellowCardCountryConfig;
        let networksData: any;
        try {
            [countryConfig, networksData] = await Promise.all([
                yellowCardService.getCountryConfig(senderCountry, fromCurrency),
                yellowCardService.getNetworks(senderCountry),
            ]);
        } catch (error: any) {
            logger.error("Failed to fetch YellowCard country config/networks for collection", { senderCountry, fromCurrency, error: error?.message });
            throw errorResponseMessage.createError(400, "Unable to fetch payment channels. Please try again.", ErrorSeverity.HIGH);
        }
        assertYellowCardRoute(countryConfig, "receive", targetType, amount);

        const allNetworks = networksData?.networks || networksData || [];
        const network = pickYellowCardNetwork(allNetworks, { accountType: targetType, provider: destination?.network });

        const sequenceId = this.generateYellowCardSequenceId();

        // Create internal transaction record
        let transaction: any;
        let transactionDetails: any;
        try {
            transaction = await transactionRepository.create({
                reason: purposeOf.reason, narration: purposeOf.narration,
            ...(topUp ? { purpose: 'top_up' as const } : {}),
                ngnValue: txNgnValue ?? undefined,
                user: userId,
                reference: sequenceId,
                amount: Math.round(amount * 100) / 100,
                fromCurrency,
                currency: toCurrency,
                detailType: DETAIL_TYPE.YELLOWCARD,
                status: TRANSACTION_STATUS.PENDING,
                initiatedAt: new Date(),
                lockedRate: userRate,
                lockedRateFromCurrency: fromCurrency,
                lockedRateToCurrency: toCurrency,
                lockedRateAt: new Date(),
                ...(paymentLinkId ? { paymentLink: paymentLinkId, payer: params.payer } : {}),
            });
        } catch (dbError: any) {
            logger.error("Failed to create collection transaction record", { error: dbError?.message, sequenceId });
            throw errorResponseMessage.createError(500, "We couldn't create this transaction. Please try again.", ErrorSeverity.CRITICAL);
        }

        if (idempotencyKey) {
            await this.idempotencyService.updateKeyWithTransaction(idempotencyKey, transaction.id);
        }

        try {
            transactionDetails = await transactionDetailRepository.create({
                transactionId: transaction.id,
                type: DETAIL_TYPE.YELLOWCARD,
                ycSequenceId: sequenceId,
                ycNetworkId: network?.id,
                ycStatus: YELLOWCARD_STATUS.PENDING,
                fromAmount: ngnAmount,
                feeAmount,
                feePercent,
                providerFeePercent,
                markupPercent,
                // What each unit fetches us at YellowCard (our USD rate when set), for profit
                providerRate,
                accountName: destination?.accountName,
                accountNumber: destination?.accountNumber,
                institutionType: destination?.accountType,
                country: senderCountry,
                // The provider as the user/payer named it, for receipts ("Mpesa", not YellowCard's network id)
                ...(destination?.network
                    ? (destination.accountType === 'bank' ? { bankName: destination.bankName || destination.network } : { momoNetwork: destination.network })
                    : {}),
            });
        } catch (dbError: any) {
            logger.error("Failed to create collection transaction detail", { error: dbError?.message, sequenceId });
            throw errorResponseMessage.createError(500, "We couldn't create this transaction. Please try again.", ErrorSeverity.CRITICAL);
        }

        let lastError: any = null;
        try {
            const collectionResponse = await yellowCardService.submitCollectionRequest({
                channelType: targetType,
                country: senderCountry,
                currency: fromCurrency,
                sequenceId,
                localAmount: amount,
                sender: kycPerson,
                destination: destination ? {
                    accountName: destination.accountName,
                    accountNumber: destination.accountNumber,
                    accountType: destination.accountType,
                    networkId: network?.id,
                } : undefined,
                forceAccept: true,
            });

            // YellowCard says which channel it routed to
            await transactionDetailRepository.updateByTransactionId(transaction.id, {
                    ycChannelId: collectionResponse?.channelId,
                    ycCollectionId: collectionResponse?.id,
                    ycStatus: collectionResponse?.status || YELLOWCARD_STATUS.PROCESSING,
                    ycRawPayload: collectionResponse,
                }
            );

            await transactionRepository.update(transaction.id, {
                status: TRANSACTION_STATUS.PROCESSING,
            });

            logger.info("YellowCard collection created", {
                transactionId: transaction.id,
                sequenceId,
                channelType: targetType,
                channelId: collectionResponse?.channelId,
                ycCollectionId: collectionResponse?.id,
            });

            return {
                ...transaction,
                status: TRANSACTION_STATUS.PROCESSING,
                details: {
                    ...transactionDetails,
                    ycChannelId: collectionResponse?.channelId,
                    ycCollectionId: collectionResponse?.id,
                    ycStatus: collectionResponse?.status || YELLOWCARD_STATUS.PROCESSING,
                },
            };
        } catch (error: any) {
            lastError = error;
        }

        // YellowCard rejected the collection
        await transactionRepository.update(transaction.id, { status: TRANSACTION_STATUS.FAILED, failedAt: new Date() });
        await transactionDetailRepository.updateByTransactionId(transaction.id, { ycStatus: YELLOWCARD_STATUS.FAILED });

        const ycError = lastError?.ycError || lastError?.response?.data || lastError?.data;
        const ycMessage = ycError?.message || ycError?.code || lastError?.message || "Collection request failed";
        logger.error("YellowCard collection rejected", { transactionId: transaction.id, sequenceId, providerMessage: ycMessage });
        throw errorResponseMessage.createError(400, providerFailureMessage(ycMessage, "receive"), ErrorSeverity.HIGH, { code: "PROVIDER_REJECTED" });
    };

    /**
     * Poll YellowCard for collection status and sync to local transaction.
     * When collection completes, credits the user's wallet with the NGN equivalent.
     */
    public pollYellowCardCollectionStatus = async (transactionId: string) => {
        const transaction = await transactionRepository.findById(transactionId);
        if (!transaction) {
            throw errorResponseMessage.createError(404, "Transaction not found", ErrorSeverity.MEDIUM);
        }

        const detail = await transactionDetailRepository.findByTransactionId(transaction.id);
        if (!detail?.ycSequenceId) {
            throw errorResponseMessage.createError(400, "This transaction has no payment reference yet.", ErrorSeverity.MEDIUM);
        }

        // Try lookup by collection ID first, then by sequence ID
        let ycCollection: any;
        try {
            if (detail.ycCollectionId) {
                ycCollection = await yellowCardService.lookupCollection(detail.ycCollectionId);
            } else {
                ycCollection = await yellowCardService.lookupCollectionBySequenceId(detail.ycSequenceId);
            }
        } catch (error: any) {
            logger.error("Failed to poll YellowCard collection status", {
                transactionId,
                sequenceId: detail.ycSequenceId,
                error: error?.ycError || error?.message,
            });
            return {
                transaction: await transactionRepository.findViewById(transaction.id),
                ycStatus: detail.ycStatus || "unknown",
                message: "We couldn't check the latest status. We'll keep trying.",
            };
        }

        const rawCollection = ycCollection?.collection || ycCollection?.data || ycCollection;
        const ycStatus = (rawCollection?.status || '')?.toLowerCase();

        logger.info("YellowCard collection poll", {
            transactionId,
            sequenceId: detail.ycSequenceId,
            ycStatus,
            localStatus: transaction.status,
        });

        // Update local detail
        await transactionDetailRepository.update(detail.id, { ycRawPayload: ycCollection, ycStatus, ycCollectionId: rawCollection?.id || detail.ycCollectionId }
        );

        // Handle completed collection → credit wallet
        if ((ycStatus === "complete" || ycStatus === "completed") && transaction.status !== TRANSACTION_STATUS.COMPLETED) {
            // Only the caller that moves the status credits the wallet, so a
            // webhook and a status check arriving together can't both do it.
            const claimed = await this.claimStatus(transaction, TRANSACTION_STATUS.COMPLETED, { completedAt: new Date() });
            if (claimed) {
                // Credit user's wallet with the NGN equivalent
                await this.creditWalletFromCollection(transaction, detail);

                logger.info("YellowCard collection completed, wallet credited", { transactionId });

                // The user hears about it from the notifier (user-notices.service), once
            }
        } else if (ycStatus === "failed" || ycStatus === "expired" || ycStatus === "cancelled") {
            const newStatus = ycStatus === "cancelled" ? TRANSACTION_STATUS.CANCELLED : TRANSACTION_STATUS.FAILED;
            await this.claimStatus(transaction, newStatus, newStatus === TRANSACTION_STATUS.FAILED ? { failedAt: new Date() } : {});
        }

        const updatedTransaction = await transactionRepository.findViewById(transactionId);
        return {
            transaction: updatedTransaction,
            ycStatus,
            ycCollection,
        };
    };

    /**
     * Credit user's wallet when a YellowCard collection completes.
     * The NGN amount is stored in detail.fromAmount (for receive: fromAmount is the NGN equivalent).
     */
    private creditWalletFromCollection = async (transaction: Transaction, detail: TransactionDetail) => {
        const userId = transaction.user;
        // detail.fromAmount is the NET NGN amount credited to the user (fee
        // already deducted). The platform receives the GROSS = net + fee from
        // the rail and books the fee into FEES_NGN.
        const ngnAmount = detail.fromAmount || transaction.amount;
        const feeAmount = detail.feeAmount || 0;
        const grossNgn = Math.round((ngnAmount + feeAmount) * 100) / 100;

        try {
            const wallet = await this.walletService.findBaseWallet(userId);
            if (!wallet) {
                logger.error("Wallet not found for collection credit", { userId });
                return;
            }

            // Make sure the user's ledger account exists.
            await this.walletService.getOrCreateWallet(userId);

            await withTransaction(async (tx) => {
                // Credit wallet in the same transaction as the journal posting.
                const credited = await this.walletService.creditBalance(wallet.id, ngnAmount, tx);
                if (!credited) throw errorResponseMessage.createError(500, "Wallet not found for collection credit", ErrorSeverity.CRITICAL);

                // Post journal: YellowCard float decreases by the gross; the
                // user's wallet receives the net; the fee lands in FEES_NGN.
                const userAccountCode = userWalletAccountCode(userId, wallet.currency);
                const legs: Array<{ accountCode: string; direction: any; amount: number }> = [
                    { accountCode: SYSTEM_ACCOUNT_CODES.YC_FLOAT_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: grossNgn },
                    { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.CREDIT, amount: ngnAmount },
                ];
                if (feeAmount > 0) {
                    legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: feeAmount });
                }
                await ledgerService.post({
                    legs,
                    source: JOURNAL_SOURCE.YC_COLLECT,
                    reference: transaction.reference,
                    description: `Collection settled — ${transaction.amount} ${transaction.fromCurrency} → ₦${ngnAmount.toFixed(2)} (fee ₦${feeAmount.toFixed(2)})`,
                    externalRef: { provider: WEBHOOK_PROVIDER.YELLOWCARD, id: transaction.reference },
                    metadata: { fromAmount: transaction.amount, fromCurrency: transaction.fromCurrency, feeAmount, grossNgn },
                    tx,
                });

                // Wallet funding record (unique per collection reference, so it can't be credited twice)
                await walletTransactionRepository.create({
                    wallet: wallet.id,
                    user: userId,
                    type: WALLET_TRANSACTION_TYPE.FUNDING as "funding",
                    status: WALLET_TRANSACTION_STATUS.SUCCESSFUL as "successful",
                    amount: ngnAmount,
                    reference: this.walletTransactionService.generateReference('COL'),
                    balanceBefore: Math.round((credited.balance - ngnAmount) * 100) / 100,
                    balanceAfter: credited.balance,
                    description: `Received ${transaction.amount} ${transaction.fromCurrency} → ₦${ngnAmount.toLocaleString()}`,
                    currency: wallet.currency,
                    paystackReference: transaction.reference, // Link to YC transaction
                    transactionId: transaction.id,
                }, tx);

                // Update ledger balance projection
                await this.walletService.adjustLedgerBalance(wallet.id, ngnAmount, tx);
            });

            logger.info("Wallet credited from collection", {
                userId,
                walletId: wallet.id,
                ngnAmount,
                foreignAmount: transaction.amount,
                foreignCurrency: transaction.fromCurrency,
            });
        } catch (error: any) {
            logger.error("CRITICAL: Failed to credit wallet from collection", {
                userId,
                transactionId: transaction.id,
                ngnAmount,
                error: error?.message,
            });
        }
    };

    /**
     * Handle YellowCard webhook callback for payment status updates.
     * Called by the webhook controller after signature verification.
     */
    public handleYellowCardWebhook = async (webhookData: any) => {
        // YellowCard sends the fields at the top level ({ event, sequenceId,
        // status, ... }); older payloads nested them under `data`.
        const event = webhookData?.event;
        const data = webhookData?.data || webhookData || {};
        const sequenceId = data.sequenceId;

        if (!sequenceId) {
            logger.warn("YellowCard webhook missing sequenceId", { event });
            return;
        }

        const detail = await transactionDetailRepository.findByYcSequenceId(sequenceId);
        if (!detail) {
            logger.warn("YellowCard webhook: no matching transaction detail", { sequenceId });
            return;
        }
        const transactionId = detail.transactionId;

        // Receives carry our collection id; the event name (RECEIVE.* now,
        // COLLECTION.* before) covers one that failed before we stored it.
        const name = String(event || "").toUpperCase();
        const isReceive = !!detail.ycCollectionId || name.startsWith("RECEIVE.") || name.startsWith("COLLECTION.");

        // The webhook only says something changed. The status we act on comes
        // from YellowCard's API, the same as a status check, so an event that
        // is replayed, out of order or forged can't move money on its own.
        const result: any = isReceive
            ? await this.pollYellowCardCollectionStatus(transactionId)
            : await this.pollYellowCardStatus(transactionId);

        if (result?.message) {
            // Couldn't reach YellowCard: fail the event so it can be replayed
            throw new Error(result.message);
        }

        logger.info("YellowCard webhook synced", {
            transactionId,
            event,
            ycStatus: result?.ycStatus,
            status: result?.transaction?.status,
        });
    };

    /**
     * Moves a transaction to `to` only if it still has the status we read.
     * Returns false when a webhook, status check or the sweeper got there
     * first, so the caller skips the wallet movement that goes with it.
     */
    private claimStatus = async (transaction: Transaction, to: TransactionStatus, extra: { completedAt?: Date; failedAt?: Date } = {}, tx?: Executor) => {
        if (!transactionStateMachine.canTransition(transaction.status, to)) return false;
        const claimed = await transactionRepository.updateIfStatus(transaction.id, transaction.status, { status: to, ...extra }, tx);
        return !!claimed;
    };

    // ============================================================================
    // GHS — Fincra: payouts to Ghana mobile money / banks, and payment-link checkouts
    // ============================================================================

    private generateGhsReference = () => {
        const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 22).toUpperCase();
        return `SP_TX_${randomPart}`;
    };

    /** Refund a failed GHS payout to the wallet that paid for it. Idempotent. */
    private refundGhsPayout = async (walletTransactionId: string, originalRef: string, reason: string) => {
        try {
            await walletSendService.refund(String(walletTransactionId), reason, {
                providerAccountCode: fincraPayoutInflightCode('GHS'),
                externalRef: { provider: WEBHOOK_PROVIDER.FINCRA, id: originalRef },
            });
        } catch (refundError: any) {
            logger.error("CRITICAL: GHS payout refund failed", { walletTransactionId, originalRef, error: refundError?.message });
        }
    };

    /**
     * Send NGN → GHS: the user's wallet pays the NGN value (at the locked rate)
     * plus the fee, and Fincra pays the recipient's mobile money or bank
     * account from the platform's GHS balance at Fincra. The final state
     * arrives by webhook (payout.successful / payout.failed) or the sweeper.
     */
    public createGhsPayoutTransaction = async (
        params: {
            amount: number;          // GHS amount the recipient will receive
            fromAmount?: number;     // ignored: the NGN amount is worked out here
            fromCurrency: 'NGN';
            toCurrency: 'GHS';
            destination: {
                accountType: 'momo' | 'bank';
                accountName: string;
                accountNumber: string;
                network?: string;    // MTN / VOD / ATM for mobile money
                bank?: string;       // bank code, SWIFT code or name for a bank
            };
            senderName?: string;
            idempotencyKey?: string;
            pin: string;
            /** Pay from the NGN wallet (default) or the GHS wallet */
            walletCurrency?: string;
        },
        userId: string,
    ) => {
        // Why the money moves (YellowCard's list); required for sends
        const purposeOf = paymentReasonOf(params, { required: true });
        await currencyAccessService.assertOn(userId, 'GHS');
        const { destination, idempotencyKey, pin } = params;
        const amount = Math.round(Number(params.amount) * 100) / 100;
        const walletCurrency = walletSendService.resolveWalletCurrency(params.walletCurrency, 'GHS');

        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }
        if (!pin) {
            throw errorResponseMessage.payloadIncorrect("Transaction PIN is required");
        }
        await this.pinService.verifyPin(userId, pin);

        const isMomo = destination.accountType !== 'bank';
        // Where the money goes, checked before anything is charged
        const beneficiaryTarget = await this.ghsPayoutTarget(destination);

        let providerRate: number;
        let userRate: number;
        let price: GhsPrice;
        await this.checkGhsLimits('send', amount);
        try {
            // The admin's pricing for NGN→GHS: Fincra's rate plus the buffer, and the fees
            price = await ghsRateService.price('send', amount);
            ({ providerRate, userRate } = price);
        } catch (err: any) {
            logger.error("GHS rate lookup failed during payout", { error: err?.message });
            throw errorResponseMessage.createError(400, "We couldn't get the NGN→GHS exchange rate right now. Please try again in a few minutes.", ErrorSeverity.HIGH);
        }
        const ngnAmount = price.subtotalNgn;
        if (!ngnAmount || ngnAmount <= 0) {
            throw errorResponseMessage.createError(400, "We couldn't work out the NGN amount from the current rate. Please try again.", ErrorSeverity.HIGH);
        }

        // The fees go on top, so the recipient gets the full GHS amount
        const feeAmount = price.feeAmount;
        const feePercent = price.feePercent;
        const providerFeePercent = ngnAmount > 0 ? Math.round((price.providerFee / ngnAmount) * 100 * 10_000) / 10_000 : 0;
        const totalDebit = price.totalNgn;

        const { ngnValue: txNgnValue } = await transactionLimitService.assertAllowed(userId, [
            { amount: totalDebit, currency: 'NGN' },
            { amount, currency: 'GHS' },
        ]);
        const markupPercent = (await platformSettingsService.getPricing()).send['NGN-GHS']?.rate.percent ?? 0;

        await walletSendService.assertCanPay(
            userId,
            walletCurrency,
            walletCurrency === 'NGN' ? totalDebit : Math.round((amount + walletSendService.walletFeeFor(amount, feePercent)) * 100) / 100,
        );

        if (idempotencyKey) {
            const duplicate = await this.findDuplicate(idempotencyKey, userId);
            if (duplicate) return duplicate;
        }

        // Fincra pays the GHS out of the platform's NGN balance, at a quote
        // for this exact amount (valid ~30s, so it's taken just before paying).
        // It deducts amountToCharge (the NGN plus its fee), which must never
        // be more than the user pays us.
        let quote: Awaited<ReturnType<typeof fincraService.quote>>;
        try {
            quote = await fincraService.quote({
                sourceCurrency: 'NGN',
                destinationCurrency: 'GHS',
                amount,
                action: 'receive',
                transactionType: 'disbursement',
                paymentDestination: isMomo ? 'mobile_money_wallet' : 'bank_account',
            });
        } catch (err: any) {
            logger.error("Fincra quote failed during GHS payout", { error: err?.message });
            throw errorResponseMessage.createError(400, "We couldn't get the NGN→GHS exchange rate right now. Please try again in a few minutes.", ErrorSeverity.HIGH);
        }
        const quoteSourceNgn = Number(quote.sourceAmount);
        const providerCost = Math.round(Number(quote.amountToCharge ?? quote.sourceAmount) * 100) / 100;
        if (!(quoteSourceNgn > 0) || !(providerCost > 0) || Number(quote.destinationAmount ?? amount) + 0.001 < amount) {
            logger.error("Fincra returned an unusable quote", { quote });
            throw errorResponseMessage.createError(400, "We couldn't get the NGN→GHS exchange rate right now. Please try again in a few minutes.", ErrorSeverity.HIGH);
        }
        if (providerCost > totalDebit) {
            // The rate moved past what we charge: refuse rather than send at a loss
            logger.warn("GHS payout refused: Fincra's cost exceeds the user's charge", { amount, totalDebit, providerCost, userRate, providerRate });
            throw errorResponseMessage.createError(409, "The exchange rate just changed. Please check the new amount and try again.", ErrorSeverity.LOW, { code: "RATE_CHANGED" });
        }

        const reference = this.generateGhsReference();

        // Wallet debit + journal, atomically. The converted amount waits in
        // FINCRA_PAYOUT_INFLIGHT_GHS (booked in NGN) until Fincra confirms.
        const { wallet, walletTransaction, walletDebit, walletFee } = await walletSendService.charge({
            userId,
            walletCurrency,
            destinationCurrency: 'GHS',
            destinationAmount: amount,
            ngnAmount,
            ngnFee: feeAmount,
            feePercent,
            providerAccountCode: fincraPayoutInflightCode('GHS'),
            source: JOURNAL_SOURCE.FINCRA_SEND,
            reference,
            description: `GHS send — ${amount} GHS to ${destination.accountName}`,
            externalRef: { provider: WEBHOOK_PROVIDER.FINCRA, id: reference },
            metadata: { destinationAmount: amount, destinationCurrency: 'GHS', destination, feeAmount, feePercent, providerFeePercent, markupPercent, providerRate, userRate },
            walletTxDescription: `Transfer to ${destination.accountName} (${amount} GHS)`,
        });

        let transaction: any;
        let transactionDetails: any;
        try {
            transaction = await transactionRepository.create({
                reason: purposeOf.reason, narration: purposeOf.narration,
                ngnValue: txNgnValue ?? undefined,
                user: userId,
                reference,
                amount,
                fromCurrency: 'NGN',
                currency: 'GHS',
                detailType: DETAIL_TYPE.FINCRA,
                status: TRANSACTION_STATUS.PENDING,
                initiatedAt: new Date(),
                lockedRate: userRate,
                lockedRateFromCurrency: 'NGN',
                lockedRateToCurrency: 'GHS',
                lockedRateAt: new Date(),
            });
            await walletTransactionRepository.update(walletTransaction.id, { paystackReference: reference, transactionId: transaction.id });
            if (idempotencyKey) await this.idempotencyService.updateKeyWithTransaction(idempotencyKey, transaction.id);
            transactionDetails = await transactionDetailRepository.create({
                transactionId: transaction.id,
                type: DETAIL_TYPE.FINCRA,
                providerReference: reference,
                providerStatus: 'pending',
                fromAmount: totalDebit,
                feeAmount,
                feePercent,
                providerQuoteReference: quote.reference,
                providerCost,
                fundingCurrency: walletCurrency,
                fundingAmount: walletDebit,
                fundingFee: walletFee,
                providerFeePercent,
                markupPercent,
                accountName: destination.accountName,
                accountNumber: destination.accountNumber,
                ...(isMomo
                    ? { momoName: destination.accountName, momoNumber: destination.accountNumber, momoNetwork: destination.network }
                    : { bankName: beneficiaryTarget.bankName }),
                institutionType: isMomo ? 'momo' : 'bank',
                country: 'GH',
            });
        } catch (dbError: any) {
            logger.error("Failed to record GHS payout, refunding wallet", { error: dbError?.message, reference });
            if (transaction?.id) await transactionRepository.update(transaction.id, { status: TRANSACTION_STATUS.FAILED, failedAt: new Date() });
            await this.refundGhsPayout(walletTransaction.id, walletTransaction.reference, "Transaction record creation failed");
            throw errorResponseMessage.createError(500, "We couldn't create this transaction. Please try again.", ErrorSeverity.CRITICAL);
        }

        const ghsCtx: GhsPayoutContext = {
            transactionId: transaction.id,
            walletTransactionId: walletTransaction.id,
            walletTxRef: walletTransaction.reference,
            userId,
            reference,
            amount,
            totalDebit,
            isMomo,
            senderName: params.senderName,
            accountName: destination.accountName,
            beneficiaryTarget,
        };

        // Over the approval limit: the money stays held and Fincra isn't asked until an admin approves
        if (await payoutHoldsService.needsApproval(userId, totalDebit)) {
            await transactionRepository.update(transaction.id, { status: TRANSACTION_STATUS.AWAITING_APPROVAL as TransactionStatus });
            await payoutHoldsService.hold({
                kind: "ghs_send", userId, transactionId: transaction.id, walletTransactionId: walletTransaction.id,
                reference, amountNgn: totalDebit, amount, currency: "GHS", recipient: destination.accountName,
                payload: { ctx: ghsCtx },
            });
            return { ...transaction, status: TRANSACTION_STATUS.AWAITING_APPROVAL, details: transactionDetails };
        }

        return this.submitGhsPayout(ghsCtx, transaction, transactionDetails, { reference: quote.reference, sourceNgn: quoteSourceNgn });
    };

    /**
     * Asks Fincra to pay out a GHS send whose money is already taken. Without a
     * quote (an approved hold, minutes later) it gets a fresh one, and if
     * Fincra now costs more than the user paid, the send is refunded instead.
     */
    public submitGhsPayout = async (ctx: GhsPayoutContext, transaction: any, transactionDetails: any, givenQuote?: { reference: string; sourceNgn: number }) => {
        const { reference, amount, isMomo, beneficiaryTarget, totalDebit } = ctx;
        const params = { senderName: ctx.senderName };
        const destination = { accountName: ctx.accountName };
        const walletTransaction = { id: ctx.walletTransactionId, reference: ctx.walletTxRef };

        const failAndRefund = async (message: string) => {
            await transactionRepository.update(transaction.id, { status: TRANSACTION_STATUS.FAILED, failedAt: new Date() });
            await transactionDetailRepository.updateByTransactionId(transaction.id, { providerStatus: 'failed' });
            await this.refundGhsPayout(walletTransaction.id, walletTransaction.reference, "Payment failed");
            logger.error("GHS payout rejected", { transactionId: transaction.id, providerMessage: message });
            throw errorResponseMessage.createError(400, `${providerFailureMessage(message, "send")} Your wallet has not been charged.`, ErrorSeverity.HIGH, { code: "PROVIDER_REJECTED" });
        };

        let quote = givenQuote;
        if (!quote) {
            try {
                const fresh = await fincraService.quote({
                    sourceCurrency: 'NGN', destinationCurrency: 'GHS', amount, action: 'receive', transactionType: 'disbursement',
                    paymentDestination: isMomo ? 'mobile_money_wallet' : 'bank_account',
                });
                const cost = Math.round(Number(fresh.amountToCharge ?? fresh.sourceAmount) * 100) / 100;
                if (!(Number(fresh.sourceAmount) > 0) || !(cost > 0)) return failAndRefund("We couldn't get a rate for this payout");
                if (cost > totalDebit) return failAndRefund("The exchange rate moved past what was paid");
                await transactionDetailRepository.updateByTransactionId(transaction.id, { providerQuoteReference: fresh.reference, providerCost: cost });
                quote = { reference: fresh.reference, sourceNgn: Number(fresh.sourceAmount) };
            } catch (error: any) {
                if (error?.response_code) throw error;
                return failAndRefund(error?.message || "We couldn't get a rate for this payout");
            }
        }
        const quoteSourceNgn = quote.sourceNgn;

        try {
            const payout = await fincraService.createPayout({
                customerReference: reference,
                sourceCurrency: 'NGN',
                destinationCurrency: 'GHS',
                // Fincra wants the quote's NGN source amount here, not the GHS
                amount: quoteSourceNgn,
                quoteReference: quote.reference,
                paymentDestination: isMomo ? 'mobile_money_wallet' : 'bank_account',
                // The user's note when they wrote one, else who it's from
                description: (transaction.narration || `Payment from ${params.senderName || 'Solution Pay'}`).slice(0, 100),
                senderName: params.senderName || 'Solution Pay',
                beneficiary: {
                    ...splitFullName(destination.accountName),
                    accountHolderName: destination.accountName,
                    accountNumber: beneficiaryTarget.accountNumber,
                    country: 'GH',
                    ...beneficiaryTarget.codes,
                },
            });
            const status = String(payout.status || 'processing').toLowerCase();
            await transactionDetailRepository.updateByTransactionId(transaction.id, { providerId: payout.reference ? String(payout.reference) : undefined, providerStatus: status, providerPayload: payout });
            await this.claimStatus(transaction, TRANSACTION_STATUS.PROCESSING as TransactionStatus);
            logger.info("GHS payout sent to Fincra", { transactionId: transaction.id, reference, status });
            if (status === 'successful' || status === 'failed') {
                await this.handleFincraPayout({ customerReference: reference, status, reference: payout.reference });
            }
            const view = await transactionRepository.findViewById(transaction.id);
            return view ?? { ...transaction, status: TRANSACTION_STATUS.PROCESSING, details: transactionDetails };
        } catch (error: any) {
            if (error?.response_code) throw error;
            if (!(error instanceof FincraError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429)) {
                // Unclear whether Fincra took it: look before refunding
                const existing = await fincraService.getPayout(reference).catch(() => undefined);
                if (existing !== null) {
                    logger.warn("GHS payout outcome unclear; left processing for the sweeper", { reference, error: error?.message });
                    await this.claimStatus(transaction, TRANSACTION_STATUS.PROCESSING as TransactionStatus);
                    const view = await transactionRepository.findViewById(transaction.id);
                    return view ?? { ...transaction, status: TRANSACTION_STATUS.PROCESSING, details: transactionDetails };
                }
            }
            return failAndRefund(error?.message || "Payout request failed");
        }
    };

    /** Fincra's account number and codes for a Ghana recipient */
    /**
     * A manual GHS send: for larger amounts (from ₦500,000), with no fee. The
     * naira comes from the NGN wallet at the buffered rate and is held until ops
     * pays the recipient (1–2 hours, 8am–8pm WAT on business days), then marks
     * it complete. Rejecting it returns the naira to the wallet.
     */
    public createManualGhsSend = async (
        params: {
            amount: number;
            destination: { accountType: 'momo' | 'bank'; accountName: string; accountNumber: string; network?: string; bank?: string };
            pin?: string;
            idempotencyKey?: string;
        },
        userId: string,
    ) => {
        // Why the money moves (YellowCard's list); required for sends
        const purposeOf = paymentReasonOf(params, { required: true });
        await currencyAccessService.assertOn(userId, 'GHS');
        const amount = Math.round(Number(params.amount) * 100) / 100;
        if (!(amount > 0)) throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        const destination = params.destination;
        if (!destination || !['momo', 'bank'].includes(destination.accountType)) {
            throw errorResponseMessage.payloadIncorrect("Choose mobile money or a bank account for the recipient");
        }
        const accountName = String(destination.accountName || '').trim();
        const accountNumber = String(destination.accountNumber || '').replace(/\s+/g, '');
        if (!accountName) throw errorResponseMessage.createError(400, "Enter the recipient's name", ErrorSeverity.LOW);
        const isMomo = destination.accountType === 'momo';
        if (isMomo) {
            let digits = accountNumber.replace(/^\+/, '');
            if (digits.startsWith('233')) digits = digits.slice(3);
            if (digits.startsWith('0')) digits = digits.slice(1);
            if (!/^\d{9}$/.test(digits)) throw errorResponseMessage.createError(400, "Enter a valid Ghana mobile money number", ErrorSeverity.LOW);
            if (!String(destination.network || '').trim()) throw errorResponseMessage.createError(400, "Choose a mobile money network", ErrorSeverity.LOW);
        } else {
            if (!String(destination.bank || '').trim()) throw errorResponseMessage.createError(400, "Choose the recipient's bank", ErrorSeverity.LOW);
            if (!/^[0-9A-Za-z-]{6,20}$/.test(accountNumber)) throw errorResponseMessage.createError(400, "Enter a valid account number", ErrorSeverity.LOW);
        }
        if (!params.pin) throw errorResponseMessage.payloadIncorrect("Transaction PIN is required");
        await this.pinService.verifyPin(userId, params.pin);

        // Manual payments run in the admin's hours, at the admin's manual rate, with no fee
        const manual = await manualSendTerms('GHS');
        const ngnAmount = Math.round(amount * manual.rate * 100) / 100;
        if (!(ngnAmount >= MANUAL_GHS_SEND.MIN_NGN)) {
            throw errorResponseMessage.createError(
                400,
                `Manual payments start at ₦${MANUAL_GHS_SEND.MIN_NGN.toLocaleString('en-US')}. For smaller amounts, use instant.`,
                ErrorSeverity.LOW,
                { code: "MANUAL_MINIMUM", minNgn: MANUAL_GHS_SEND.MIN_NGN },
            );
        }
        const { ngnValue: txNgnValue } = await transactionLimitService.assertAllowed(userId, [
            { amount: ngnAmount, currency: 'NGN' },
            { amount, currency: 'GHS' },
        ]);
        await walletSendService.assertCanPay(userId, 'NGN', ngnAmount);

        if (params.idempotencyKey) {
            const duplicate = await this.findDuplicate(params.idempotencyKey, userId);
            if (duplicate) return duplicate;
        }

        const detailType = (isMomo ? DETAIL_TYPE.MOBILE_MONEY : DETAIL_TYPE.BANK_TRANSFER) as DetailType;
        const transaction = await transactionRepository.create({
                reason: purposeOf.reason, narration: purposeOf.narration,
            ngnValue: txNgnValue ?? undefined,
            user: userId,
            reference: this.generateBankTransferTransactionReference('GHS'),
            amount,
            fromCurrency: 'NGN',
            currency: 'GHS',
            detailType,
            status: TRANSACTION_STATUS.PENDING_INPUT as TransactionStatus,
            initiatedAt: new Date(),
            lockedRate: manual.rate,
            lockedRateFromCurrency: 'NGN',
            lockedRateToCurrency: 'GHS',
            lockedRateAt: new Date(),
        });
        if (params.idempotencyKey) await this.idempotencyService.updateKeyWithTransaction(params.idempotencyKey, transaction.id);

        const details = await transactionDetailRepository.create({
            transactionId: transaction.id,
            type: detailType,
            institutionType: isMomo ? 'momo' : 'bank',
            fromAmount: ngnAmount,
            feeAmount: 0,
            feePercent: 0,
            fundingCurrency: 'NGN',
            fundingAmount: ngnAmount,
            fundingFee: 0,
            accountName,
            ...(isMomo
                ? { momoName: accountName, momoNumber: accountNumber, momoNetwork: destination.network }
                : { bankName: String(destination.bank).trim(), accountNumber }),
        } as any);

        // The naira leaves the wallet now and waits for ops
        try {
            await withTransaction(async (tx) => {
                await walletSendService.holdForManualPayout({
                    userId,
                    currency: 'NGN',
                    amount: ngnAmount,
                    transactionId: transaction.id,
                    reference: transaction.reference,
                    description: `Manual payment to ${accountName} (GHS ${amount.toLocaleString('en-US')})`,
                }, tx);
                await transactionRepository.update(transaction.id, { status: TRANSACTION_STATUS.AWAITING_CONFIRMATION as TransactionStatus }, tx);
            });
        } catch (error) {
            await transactionRepository.update(transaction.id, { status: TRANSACTION_STATUS.CANCELLED as TransactionStatus, cancelReason: "Wallet payment could not be taken" });
            throw error;
        }

        const recipient = isMomo
            ? `${accountName} · ${destination.network} mobile money ${accountNumber}`
            : `${accountName} · ${destination.bank} ${accountNumber}`;
        Promise.resolve().then(() => this.notificationService.notifyAdmins(config.ADMIN_EMAILS, {
            title: 'New manual GHS payment',
            type: 'transaction.manual',
            message: `${transaction.reference}: pay GHS ${amount.toLocaleString('en-US')} to ${recipient}. ₦${ngnAmount.toLocaleString('en-US')} is held from the customer's wallet.`,
            actionUrl: `${config.FRONTEND_URL}/dashboard/admin/transactions`,
            buttonText: 'Open transactions',
        } as any, config.ADMIN_PHONE_NUMBERS)).catch(() => undefined);

        const created = await transactionRepository.findById(transaction.id);
        return { ...(created ?? transaction), details: { ...details } };
    };

    private ghsPayoutTarget = async (destination: { accountType: 'momo' | 'bank'; accountNumber: string; network?: string; bank?: string }) => {
        const number = String(destination.accountNumber || '').replace(/\s+/g, '');
        if (destination.accountType !== 'bank') {
            // Fincra takes the number in international form without "+": 233241234567
            let digits = number.replace(/^\+/, '');
            if (digits.startsWith('233')) digits = digits.slice(3);
            if (digits.startsWith('0')) digits = digits.slice(1);
            if (!/^\d{9}$/.test(digits)) {
                throw errorResponseMessage.createError(400, "Enter a valid Ghana mobile money number", ErrorSeverity.LOW);
            }
            let mobileMoneyCode: string;
            try {
                mobileMoneyCode = await fincraService.ghsMobileMoneyCode(destination.network || '');
            } catch (error: any) {
                throw errorResponseMessage.createError(400, error?.message || "Choose a mobile money network", ErrorSeverity.LOW);
            }
            return { accountNumber: `233${digits}`, codes: { mobileMoneyCode }, bankName: undefined as string | undefined };
        }
        const wanted = String(destination.bank || '').trim().toUpperCase();
        if (!wanted) throw errorResponseMessage.createError(400, "Choose the recipient's bank", ErrorSeverity.LOW);
        const banks = await fincraService.listBanks('GH', 'GHS', 'bank_account');
        // By code or SWIFT, else by name (the built-in list sends names, which may be worded differently)
        const bank = banks.find((b) => b.code.toUpperCase() === wanted || (b.swiftCode || '').toUpperCase() === wanted || b.name.toUpperCase() === wanted)
            || banks.find((b) => canonicalBankKey(b.name) === canonicalBankKey(wanted));
        if (!bank) throw errorResponseMessage.createError(400, "We don't recognise that bank. Choose it from the list.", ErrorSeverity.LOW);
        return {
            accountNumber: number,
            codes: { bankCode: bank.code, ...(bank.swiftCode ? { bankSwiftCode: bank.swiftCode } : {}) },
            bankName: bank.name,
        };
    };

    /**
     * Receive GHS → NGN: a Fincra checkout link the payer opens to pay by
     * mobile money. Once Fincra confirms the payment, the user's NGN wallet
     * gets the GHS at the locked rate, less the fee.
     */
    public createGhsCollectionTransaction = async (
        params: {
            amount: number;          // GHS the payer pays
            fromAmount?: number;     // ignored: worked out here
            fromCurrency: 'GHS';
            toCurrency: 'NGN';
            sender?: { accountName?: string; accountNumber?: string; network?: string; email?: string };
            idempotencyKey?: string;
            paymentLinkId?: string;
            payer?: { name?: string; email?: string; phone?: string };
            /** Where Fincra sends the payer afterwards */
            redirectUrl?: string;
            /** The user is paying cedis into their own wallet (no payer of their own) */
            topUp?: boolean;
        },
        userId: string,
    ) => {
        // Why the money moves (YellowCard's list); optional for receives
        const purposeOf = paymentReasonOf(params, { required: false });
        await currencyAccessService.assertOn(userId, 'GHS');
        const { idempotencyKey, paymentLinkId } = params;
        const amount = Number(params.amount);
        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }
        if (!Number.isInteger(amount)) {
            throw errorResponseMessage.createError(400, "GHS payments are in whole cedis. Enter an amount without pesewas.", ErrorSeverity.LOW);
        }

        let providerRate: number;
        let userRate: number;
        let price: GhsPrice;
        await this.checkGhsLimits('receive', amount);
        try {
            // The admin's pricing for GHS→NGN: Fincra's rate less the buffer, and the fees
            price = await ghsRateService.price('receive', amount);
            ({ providerRate, userRate } = price);
        } catch (err: any) {
            logger.error("GHS rate lookup failed during collection", { error: err?.message });
            throw errorResponseMessage.createError(400, "We couldn't get the GHS→NGN exchange rate right now. Please try again in a few minutes.", ErrorSeverity.HIGH);
        }
        const grossNgn = price.subtotalNgn;
        if (!grossNgn || grossNgn <= 0) {
            throw errorResponseMessage.createError(400, "We couldn't work out the NGN amount from the current rate. Please try again.", ErrorSeverity.HIGH);
        }

        const { ngnValue: txNgnValue } = await transactionLimitService.assertAllowed(userId, [
            { amount, currency: 'GHS' },
            { amount: grossNgn, currency: 'NGN' },
        ]);

        // The fees come out of the credit: the user receives gross − fees
        const feeAmount = price.feeAmount;
        const feePercent = price.feePercent;
        const providerFeePercent = grossNgn > 0 ? Math.round((price.providerFee / grossNgn) * 100 * 10_000) / 10_000 : 0;
        const ngnAmount = price.totalNgn;
        if (ngnAmount <= 0) {
            throw errorResponseMessage.createError(400, "Fee exceeds the converted amount. Please increase the amount.", ErrorSeverity.MEDIUM);
        }
        const markupPercent = (await platformSettingsService.getPricing()).receive['GHS-NGN']?.rate.percent ?? 0;

        if (idempotencyKey) {
            const duplicate = await this.findDuplicate(idempotencyKey, userId);
            if (duplicate) return duplicate;
        }

        const owner = await userRepository.findById(userId);
        const reference = this.generateGhsReference();
        const payerName = (params.payer?.name || params.sender?.accountName || '').trim() || 'Customer';
        const payerEmail = params.payer?.email || params.sender?.email || owner?.email;
        if (!payerEmail) throw errorResponseMessage.payloadIncorrect("Enter the payer's email address");

        const transaction = await transactionRepository.create({
                reason: purposeOf.reason, narration: purposeOf.narration,
            ngnValue: txNgnValue ?? undefined,
            user: userId,
            reference,
            amount,
            fromCurrency: 'GHS',
            currency: 'NGN',
            detailType: DETAIL_TYPE.FINCRA,
            status: TRANSACTION_STATUS.PENDING,
            initiatedAt: new Date(),
            lockedRate: userRate,
            lockedRateFromCurrency: 'GHS',
            lockedRateToCurrency: 'NGN',
            lockedRateAt: new Date(),
            ...(paymentLinkId ? { paymentLink: paymentLinkId, payer: params.payer } : {}),
            ...(params.topUp ? { purpose: 'top_up' as const } : {}),
        });
        if (idempotencyKey) await this.idempotencyService.updateKeyWithTransaction(idempotencyKey, transaction.id);

        const transactionDetails = await transactionDetailRepository.create({
            transactionId: transaction.id,
            type: DETAIL_TYPE.FINCRA,
            providerReference: reference,
            providerStatus: 'pending',
            fromAmount: ngnAmount,
            feeAmount,
            feePercent,
            providerFeePercent,
            markupPercent,
            momoName: params.sender?.accountName || params.payer?.name,
            momoNumber: params.sender?.accountNumber,
            momoNetwork: params.sender?.network,
            institutionType: 'momo',
            country: 'GH',
        });

        // With the payer's mobile money details, charge their phone directly: no second form.
        // If Fincra hasn't enabled it (or refuses this network), fall back to the checkout page.
        const payerPhone = ghanaIntl(params.sender?.accountNumber);
        const operator = ghsMomoOperator(params.sender?.network);
        if (config.FINCRA_DIRECT_CHARGE && payerPhone && operator) {
            try {
                const charge = await fincraService.directCharge({
                    currency: 'GHS',
                    amount,
                    reference,
                    customer: { name: payerName, email: payerEmail, phoneNumber: payerPhone },
                    phone: payerPhone,
                    operator,
                });
                await transactionDetailRepository.updateByTransactionId(transaction.id, {
                    providerId: String(charge.id ?? ''),
                    providerStatus: 'awaiting_approval',
                    providerPayload: { ...charge, directCharge: true },
                });
                await this.claimStatus(transaction, TRANSACTION_STATUS.PROCESSING as TransactionStatus);
                const otpRequired = String(charge.auth_model || '').toUpperCase() === 'OTP';
                logger.info("GHS direct charge started", { transactionId: transaction.id, reference, otpRequired });
                return {
                    ...transaction,
                    status: TRANSACTION_STATUS.PROCESSING,
                    details: { ...transactionDetails, providerStatus: 'awaiting_approval' },
                    approval: {
                        otpRequired,
                        message: otpRequired
                            ? "Enter the code sent to your phone to approve the payment."
                            : "Approve the payment on your phone. Check for a prompt and enter your mobile money PIN.",
                    },
                };
            } catch (error: any) {
                logger.warn("GHS direct charge unavailable; using the checkout page", { transactionId: transaction.id, providerMessage: error?.message });
            }
        }

        try {
            const checkout = await fincraService.createCheckout({
                currency: 'GHS',
                amount,
                // The phone prefills Fincra's page where it can
                customer: { name: payerName, email: payerEmail, ...(payerPhone ? { phoneNumber: payerPhone } : {}) },
                paymentMethods: FINCRA_CHECKOUT_METHODS.GHS,
                feeBearer: 'business',
                reference,
                redirectUrl: params.redirectUrl,
                metadata: { reference, transactionId: transaction.id },
            });
            await transactionDetailRepository.updateByTransactionId(transaction.id, {
                checkoutUrl: checkout.link,
                providerId: checkout.reference,
                providerStatus: 'initiated',
                providerPayload: checkout,
            });
            await this.claimStatus(transaction, TRANSACTION_STATUS.PROCESSING as TransactionStatus);
            logger.info("GHS checkout created", { transactionId: transaction.id, reference });
            return {
                ...transaction,
                status: TRANSACTION_STATUS.PROCESSING,
                details: { ...transactionDetails, checkoutUrl: checkout.link, providerStatus: 'initiated' },
                checkoutUrl: checkout.link,
            };
        } catch (error: any) {
            await transactionRepository.update(transaction.id, { status: TRANSACTION_STATUS.FAILED, failedAt: new Date() });
            await transactionDetailRepository.updateByTransactionId(transaction.id, { providerStatus: 'failed' });
            const message = error?.message || "Collection request failed";
            logger.error("GHS checkout rejected", { transactionId: transaction.id, providerMessage: message });
            throw errorResponseMessage.createError(400, providerFailureMessage(message, "receive"), ErrorSeverity.HIGH, { code: "PROVIDER_REJECTED" });
        }
    };

    /**
     * A payment-link payment settled: credit the owner's NGN wallet at the
     * locked rate, less the fee. The GHS sits in the platform's Fincra GHS
     * balance (CASH_FINCRA_GHS, booked at NGN value).
     */
    private creditWalletFromGhsCollection = async (
        transaction: Transaction,
        detail: TransactionDetail,
        walletId: string,
        tx: Executor,
        // Where the GHS is held: Fincra's checkout by default, or a Spotflow account
        rail: { cash: string; source: string; provider: string } = { cash: fincraCashCode('GHS'), source: JOURNAL_SOURCE.FINCRA_COLLECT, provider: WEBHOOK_PROVIDER.FINCRA },
    ) => {
        const userId = transaction.user;
        const ngnAmount = detail.fromAmount || 0;
        const feeAmount = detail.feeAmount || 0;
        const grossNgn = Math.round((ngnAmount + feeAmount) * 100) / 100;
        if (!(ngnAmount > 0)) {
            throw errorResponseMessage.createError(500, `GHS collection ${transaction.id} has no NGN amount to credit`, ErrorSeverity.CRITICAL);
        }

        const credited = await this.walletService.creditBalance(walletId, ngnAmount, tx);
        if (!credited) throw errorResponseMessage.createError(500, "Wallet not found for collection credit", ErrorSeverity.CRITICAL);

        const legs: Array<{ accountCode: string; direction: any; amount: number }> = [
            { accountCode: rail.cash, direction: JOURNAL_DIRECTION.DEBIT, amount: grossNgn },
            { accountCode: userWalletAccountCode(userId, credited.currency), direction: JOURNAL_DIRECTION.CREDIT, amount: ngnAmount },
        ];
        if (feeAmount > 0) legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: feeAmount });
        await ledgerService.post({
            legs,
            source: rail.source as any,
            reference: transaction.reference,
            description: `GHS received — ${transaction.amount} GHS → ₦${ngnAmount.toFixed(2)} (fee ₦${feeAmount.toFixed(2)})`,
            externalRef: { provider: rail.provider as any, id: transaction.reference },
            metadata: { fromAmount: transaction.amount, fromCurrency: 'GHS', feeAmount, grossNgn },
            tx,
        });

        // The unique funding reference is a second guard against crediting twice
        await walletTransactionRepository.create({
            wallet: walletId,
            user: userId,
            type: WALLET_TRANSACTION_TYPE.FUNDING as "funding",
            status: WALLET_TRANSACTION_STATUS.SUCCESSFUL as "successful",
            amount: ngnAmount,
            reference: this.walletTransactionService.generateReference('COL'),
            balanceBefore: Math.round((credited.balance - ngnAmount) * 100) / 100,
            balanceAfter: credited.balance,
            description: `Received ${transaction.amount} GHS → ₦${ngnAmount.toLocaleString()}`,
            currency: credited.currency,
            paystackReference: transaction.reference,
            transactionId: transaction.id,
        }, tx);

        await this.walletService.adjustLedgerBalance(walletId, ngnAmount, tx);
    };

    /**
     * Receive GHS → NGN by bank transfer: a one-time Spotflow GHS account for
     * exactly this amount (valid about 30 minutes). The payer transfers to it
     * from any Ghanaian bank; Spotflow's webhook confirms the credit, and the
     * user's NGN wallet gets the GHS at the locked rate, less the fee (the
     * same pricing as every GHS receive).
     */
    public createGhsAccountCollection = async (
        params: { amount: number; paymentLinkId?: string; payer?: { name?: string; email?: string; phone?: string }; idempotencyKey?: string },
        userId: string,
    ) => {
        await currencyAccessService.assertOn(userId, 'GHS');
        if (!spotflowService.ghsAccountsAvailable) {
            throw errorResponseMessage.createError(503, "Paying by bank transfer in Ghana isn't available right now. Use a payment link instead.", ErrorSeverity.LOW, { code: "GHS_ACCOUNTS_UNAVAILABLE" });
        }
        const amount = Math.round(Number(params.amount) * 100) / 100;
        if (!(amount > 0)) throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        if (amount < 1) throw errorResponseMessage.createError(400, "The smallest amount is GHS 1.", ErrorSeverity.LOW);

        let price: GhsPrice;
        await this.checkGhsLimits('receive', amount);
        try {
            price = await ghsRateService.price('receive', amount);
        } catch (err: any) {
            logger.error("GHS rate lookup failed for a GHS account", { error: err?.message });
            throw errorResponseMessage.createError(400, "We couldn't get the GHS→NGN exchange rate right now. Please try again in a few minutes.", ErrorSeverity.HIGH);
        }
        const grossNgn = price.subtotalNgn;
        const ngnAmount = price.totalNgn;
        if (!(grossNgn > 0) || !(ngnAmount > 0)) {
            throw errorResponseMessage.createError(400, "This amount is too small after the fee. Please increase it.", ErrorSeverity.MEDIUM);
        }
        const { ngnValue: txNgnValue } = await transactionLimitService.assertAllowed(userId, [
            { amount, currency: 'GHS' },
            { amount: grossNgn, currency: 'NGN' },
        ]);
        if (params.idempotencyKey) {
            const duplicate = await this.findDuplicate(params.idempotencyKey, userId);
            if (duplicate) return duplicate;
        }

        const owner = await userRepository.findById(userId);
        const ownerName = `${owner?.firstName || ''} ${owner?.lastName || ''}`.trim() || 'SolutionPay customer';
        const reference = this.generateGhsReference();
        const providerFeePercent = Math.round((price.providerFee / grossNgn) * 100 * 10_000) / 10_000;
        const markupPercent = (await platformSettingsService.getPricing()).receive['GHS-NGN']?.rate.percent ?? 0;

        const transaction = await transactionRepository.create({
            ngnValue: txNgnValue ?? undefined,
            user: userId,
            reference,
            amount,
            fromCurrency: 'GHS',
            currency: 'NGN',
            detailType: DETAIL_TYPE.SPOTFLOW as DetailType,
            status: TRANSACTION_STATUS.PENDING,
            initiatedAt: new Date(),
            lockedRate: price.userRate,
            lockedRateFromCurrency: 'GHS',
            lockedRateToCurrency: 'NGN',
            lockedRateAt: new Date(),
            ...(params.paymentLinkId ? { paymentLink: params.paymentLinkId, payer: params.payer } : {}),
        });
        if (params.idempotencyKey) await this.idempotencyService.updateKeyWithTransaction(params.idempotencyKey, transaction.id);

        const detail = await transactionDetailRepository.create({
            transactionId: transaction.id,
            type: DETAIL_TYPE.SPOTFLOW as DetailType,
            providerReference: reference,
            providerStatus: 'pending',
            fromAmount: ngnAmount,
            feeAmount: price.feeAmount,
            feePercent: price.feePercent,
            providerFeePercent,
            markupPercent,
            institutionType: 'bank',
            country: 'GH',
        });

        try {
            const account: any = await spotflowService.createDynamicAccount('GHS', ownerName, amount);
            const accountId = String(account?.id || '');
            const accountNumber = String(account?.accountNumber || account?.account_number || '');
            if (!accountId || !accountNumber) throw new Error("Spotflow didn't return an account");
            // Spotflow says when it closes; otherwise its 30-minute default
            const given = new Date(String(account?.expiresAt || account?.expires_at || ''));
            const expiresAt = Number.isFinite(given.getTime()) && given.getTime() > Date.now() ? given : new Date(Date.now() + GHS_ACCOUNT_LIFETIME_MS);
            const payTo = {
                accountId,
                accountNumber,
                accountName: String(account?.accountName || account?.account_name || ownerName),
                bankName: String(account?.bankName || account?.bank_name || ''),
                expiresAt: expiresAt.toISOString(),
            };
            await transactionDetailRepository.update(detail.id, {
                providerId: accountId,
                providerStatus: 'awaiting_transfer',
                providerPayload: { account, payTo },
                accountNumber: payTo.accountNumber,
                accountName: payTo.accountName,
                bankName: payTo.bankName,
            });
            await this.claimStatus(transaction, TRANSACTION_STATUS.PROCESSING as TransactionStatus);
            logger.info("GHS account created", { transactionId: transaction.id, reference });
            return { ...transaction, status: TRANSACTION_STATUS.PROCESSING, payTo, ngnAmount, feeAmount: price.feeAmount, rate: price.userRate };
        } catch (error: any) {
            await transactionRepository.update(transaction.id, { status: TRANSACTION_STATUS.FAILED, failedAt: new Date() });
            await transactionDetailRepository.update(detail.id, { providerStatus: 'failed' });
            logger.error("GHS account could not be created", { transactionId: transaction.id, error: error?.message });
            throw errorResponseMessage.createError(400, "We couldn't create a Ghana account number right now. Please try again in a few minutes.", ErrorSeverity.HIGH, { code: "PROVIDER_REJECTED" });
        }
    };

    /**
     * Money arrived in a one-time GHS account (Spotflow's
     * account_credit_successful). Signed by Spotflow, matched to our
     * transaction by the account it was paid into, and credited only for the
     * exact amount asked. The claim and the credit commit together, so
     * retries act once; a failure throws so the webhook is retried.
     */
    public handleSpotflowCredit = async (data: any): Promise<{ outcome: 'credited' | 'ignored'; note?: string }> => {
        const accountId = String(data?.account?.id || data?.accountId || data?.account_id || '');
        const status = String(data?.status || '').toLowerCase();
        const type = String(data?.type || 'credit').toLowerCase();
        const currency = String(data?.currency || '').toUpperCase();
        const paid = Number(data?.amount);
        const spotflowReference = String(data?.spotflowReference || data?.spotflow_reference || data?.reference || '');

        if (!accountId || type !== 'credit') return { outcome: 'ignored', note: 'not a credit to an account' };
        const detail = await transactionDetailRepository.findByProviderId(accountId, DETAIL_TYPE.SPOTFLOW);
        // A credit to some other account (the main account, a lab account): not ours to handle
        if (!detail) return { outcome: 'ignored', note: 'no transaction for this account' };
        const transaction = await transactionRepository.findById(detail.transactionId);
        if (!transaction) return { outcome: 'ignored', note: 'transaction missing' };
        if (transaction.status === TRANSACTION_STATUS.COMPLETED) return { outcome: 'ignored', note: 'already credited' };

        const record = { lastCredit: data, receivedAt: new Date().toISOString() };
        const payload = { ...((detail.providerPayload as any) || {}), ...record };
        if (status !== 'successful' && status !== 'success') {
            await transactionDetailRepository.update(detail.id, { providerStatus: status || 'unknown', providerPayload: payload });
            return { outcome: 'ignored', note: `credit status ${status}` };
        }
        if (currency !== 'GHS' || !(Math.abs(paid - transaction.amount) < 0.01)) {
            // Too little, too much or the wrong currency: the money is with Spotflow, a person decides
            logger.error("CRITICAL: GHS account paid a different amount; not credited, reconcile manually", { reference: transaction.reference, expected: transaction.amount, paid, currency, spotflowReference });
            await transactionDetailRepository.update(detail.id, { providerStatus: 'amount_mismatch', providerPayload: payload });
            Promise.resolve().then(() => this.notificationService.notifyAdmins(config.ADMIN_EMAILS, {
                title: 'GHS account paid the wrong amount',
                type: 'reconciliation.alert',
                permission: 'technical',
                actionUrl: `${config.FRONTEND_URL}/dashboard/admin/reconciliation`,
                message: `Transaction ${transaction.reference} expected GHS ${transaction.amount} but Spotflow reports ${currency} ${paid} (${spotflowReference}). Nothing was credited; please reconcile it by hand.`,
            } as any, config.ADMIN_PHONE_NUMBERS)).catch(() => undefined);
            return { outcome: 'ignored', note: 'amount mismatch' };
        }
        if (transaction.status === TRANSACTION_STATUS.FAILED || transaction.status === TRANSACTION_STATUS.CANCELLED) {
            logger.error("CRITICAL: GHS account paid after the request was closed; not credited, reconcile manually", { reference: transaction.reference, spotflowReference });
            await transactionDetailRepository.update(detail.id, { providerStatus: 'paid_after_close', providerPayload: payload });
            Promise.resolve().then(() => this.notificationService.notifyAdmins(config.ADMIN_EMAILS, {
                title: 'GHS account paid after it closed',
                type: 'reconciliation.alert',
                permission: 'technical',
                actionUrl: `${config.FRONTEND_URL}/dashboard/admin/reconciliation`,
                message: `Transaction ${transaction.reference} was paid (GHS ${paid}, ${spotflowReference}) after it was closed. Nothing was credited; please reconcile it by hand.`,
            } as any, config.ADMIN_PHONE_NUMBERS)).catch(() => undefined);
            return { outcome: 'ignored', note: 'paid after close' };
        }

        const wallet = await this.walletService.getOrCreateWallet(transaction.user);
        const credited = await withTransaction(async (tx) => {
            if (!(await this.claimStatus(transaction, TRANSACTION_STATUS.COMPLETED as TransactionStatus, { completedAt: new Date() }, tx))) return false;
            await this.creditWalletFromGhsCollection(transaction, detail, wallet.id, tx, {
                cash: spotflowCashCode('GHS'),
                source: JOURNAL_SOURCE.SPOTFLOW_COLLECT,
                provider: WEBHOOK_PROVIDER.SPOTFLOW,
            });
            await transactionDetailRepository.update(detail.id, { providerStatus: 'successful', providerPayload: payload }, tx);
            return true;
        });
        if (!credited) return { outcome: 'ignored', note: 'already credited' };
        logger.info("Wallet credited from GHS account", { userId: transaction.user, transactionId: transaction.id, ghsAmount: transaction.amount });
        // The user hears about it from the notifier (user-notices.service), once
        return { outcome: 'credited' };
    };

    /** One-time accounts nobody paid: closed once well past their expiry */
    public expireGhsAccountCollections = async () => {
        const cutoff = new Date(Date.now() - GHS_ACCOUNT_LIFETIME_MS - GHS_ACCOUNT_GRACE_MS);
        const stale = await transactionRepository.listStale(DETAIL_TYPE.SPOTFLOW as DetailType, [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.PROCESSING] as TransactionStatus[], cutoff, 200);
        let closed = 0;
        for (const transaction of stale) {
            if (await this.claimStatus(transaction, TRANSACTION_STATUS.FAILED as TransactionStatus, { failedAt: new Date(), cancelReason: "No transfer arrived before the account expired" } as any)) closed++;
        }
        if (closed) logger.info("Closed unpaid GHS accounts", { closed });
        return closed;
    };

    /**
     * A payout's outcome, from Fincra's payout.* webhook or a status check.
     * Safe to call any number of times, in any order, concurrently: the
     * status claim and the money movement it unlocks commit together, so a
     * retried webhook, a poll and the sweeper act once between them, and a
     * crash part-way leaves nothing behind for the retry to trip over. A
     * payout that has settled one way is never moved the other way.
     */
    public handleFincraPayout = async (data: { customerReference?: string; reference?: string; status?: string; reason?: string; message?: string; [key: string]: unknown }) => {
        const reference = String(data.customerReference || '');
        if (!reference) return false;
        const detail = await transactionDetailRepository.findByProviderReference(reference);
        if (!detail) return false;
        const transaction = await transactionRepository.findById(detail.transactionId);
        if (!transaction) return false;

        const status = String(data.status || '').toLowerCase();
        const succeeded = status === 'successful' || status === 'success';
        const failed = status === 'failed' || status === 'cancelled' || status === 'reversed';

        // Already settled: a retry agrees and changes nothing; a contradiction needs a person
        if (transaction.status === TRANSACTION_STATUS.COMPLETED || transaction.status === TRANSACTION_STATUS.FAILED) {
            const agrees = (transaction.status === TRANSACTION_STATUS.COMPLETED && succeeded) || (transaction.status === TRANSACTION_STATUS.FAILED && !succeeded);
            if (!agrees && (succeeded || failed)) {
                logger.error("CRITICAL: Fincra payout status contradicts a settled transaction; left as is, reconcile manually", {
                    transactionId: transaction.id, reference, ours: transaction.status, fincra: status,
                });
            }
            // A failure whose refund didn't finish (crash) is completed here; the refund is idempotent
            if (transaction.status === TRANSACTION_STATUS.FAILED && failed) {
                const walletTx = await walletTransactionRepository.findByPaystackReference(transaction.reference, WALLET_TRANSACTION_TYPE.TRANSFER as "transfer");
                if (walletTx && walletTx.status !== WALLET_TRANSACTION_STATUS.FAILED && walletTx.status !== WALLET_TRANSACTION_STATUS.REVERSED) {
                    await this.refundGhsPayout(walletTx.id, walletTx.reference, 'Payment failed');
                }
            }
            return true;
        }

        await transactionDetailRepository.update(detail.id, {
            providerStatus: status || detail.providerStatus,
            providerId: data.reference ? String(data.reference) : detail.providerId,
            providerPayload: data,
        });

        if (succeeded) {
            const settled = await withTransaction(async (tx) => {
                if (!(await this.claimStatus(transaction, TRANSACTION_STATUS.COMPLETED as TransactionStatus, { completedAt: new Date() }, tx))) return false;
                const convertedNgn = Math.round(((detail.fromAmount || 0) - (detail.feeAmount || 0)) * 100) / 100;
                if (convertedNgn > 0) {
                    const cost = detail.providerCost;
                    const legs: Array<{ accountCode: string; direction: any; amount: number }> = [
                        { accountCode: fincraPayoutInflightCode('GHS'), direction: JOURNAL_DIRECTION.DEBIT, amount: convertedNgn },
                    ];
                    if (cost && cost > 0) {
                        // Paid from the NGN balance: Fincra took `cost`; the rest of the
                        // converted amount (our rate markup less Fincra's fee) is revenue
                        legs.push({ accountCode: fincraCashCode('NGN'), direction: JOURNAL_DIRECTION.CREDIT, amount: cost });
                        const spread = Math.round((convertedNgn - cost) * 100) / 100;
                        if (spread > 0) legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: spread });
                        if (spread < 0) legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: -spread });
                    } else {
                        // Payouts made before this change were paid from the GHS balance
                        legs.push({ accountCode: fincraCashCode('GHS'), direction: JOURNAL_DIRECTION.CREDIT, amount: convertedNgn });
                    }
                    await ledgerService.post({
                        legs,
                        source: JOURNAL_SOURCE.FINCRA_SEND,
                        reference: transaction.reference,
                        description: `GHS payout settled by Fincra`,
                        externalRef: { provider: WEBHOOK_PROVIDER.FINCRA, id: transaction.reference },
                        metadata: cost ? { providerCost: cost, quoteReference: detail.providerQuoteReference } : undefined,
                        tx,
                    });
                }
                const walletTx = await walletTransactionRepository.findByPaystackReference(transaction.reference, WALLET_TRANSACTION_TYPE.TRANSFER as "transfer", tx);
                if (walletTx) {
                    const claimed = await walletTransactionRepository.claim(
                        walletTx.id,
                        [WALLET_TRANSACTION_STATUS.SUCCESSFUL as "successful", WALLET_TRANSACTION_STATUS.FAILED as "failed", WALLET_TRANSACTION_STATUS.REVERSED as "reversed"],
                        { status: WALLET_TRANSACTION_STATUS.SUCCESSFUL as "successful" },
                        tx
                    );
                    if (claimed) await this.walletService.adjustLedgerBalance(claimed.wallet, -claimed.amount, tx);
                }
                return true;
            });
            // The user hears about it from the notifier (user-notices.service), once
            return true;
        }

        if (failed) {
            // Refund only after winning the move to FAILED, so a payout that
            // completed in the meantime is never refunded
            if (await this.claimStatus(transaction, TRANSACTION_STATUS.FAILED as TransactionStatus, { failedAt: new Date() })) {
                const walletTx = await walletTransactionRepository.findByPaystackReference(transaction.reference, WALLET_TRANSACTION_TYPE.TRANSFER as "transfer");
                if (walletTx) await this.refundGhsPayout(walletTx.id, walletTx.reference, 'Payment failed');
            }
            return true;
        }

        logger.info("GHS payout intermediate status", { transactionId: transaction.id, status });
        return true;
    };

    /**
     * A checkout's outcome (charge.successful webhook or a status check). The
     * status is always confirmed with Fincra by our reference, so only a
     * payment Fincra itself reports as successful, for the full amount,
     * credits anything. The claim and the credit commit together: retries
     * and polls credit once, and a failure throws so the webhook is retried.
     */
    public handleFincraCheckout = async (reference: string) => {
        const detail = await transactionDetailRepository.findByProviderReference(reference);
        const direct = (detail?.providerPayload as any)?.directCharge === true;
        if (!detail || (!detail.checkoutUrl && !direct)) return false;
        const transaction = await transactionRepository.findById(detail.transactionId);
        if (!transaction) return false;
        if (transaction.status === TRANSACTION_STATUS.COMPLETED) return true; // credited already

        let checkout: any;
        try {
            checkout = direct ? await fincraService.getChargeByReference(reference) : await fincraService.getCheckout(reference);
        } catch (error: any) {
            if (error instanceof FincraError && error.status === 404) return true; // not started yet
            throw error;
        }
        // Keep knowing how it was started
        if (direct && checkout && typeof checkout === 'object') checkout = { ...checkout, directCharge: true };
        const status = String(checkout?.status || '').toLowerCase();

        if (status === 'success' || status === 'successful') {
            const paid = Number(checkout?.amount ?? checkout?.amountReceived ?? 0);
            if (String(checkout?.currency || 'GHS').toUpperCase() !== 'GHS' || paid + 0.001 < transaction.amount) {
                logger.error("CRITICAL: GHS checkout paid a different amount; not credited", { reference, expected: transaction.amount, paid, currency: checkout?.currency });
                await transactionDetailRepository.update(detail.id, { providerStatus: status, providerPayload: checkout });
                return true;
            }
            if (transaction.status === TRANSACTION_STATUS.FAILED) {
                // Paid after we expired the link: money arrived, so a person decides
                logger.error("CRITICAL: GHS payment link paid after it was marked failed; not credited, reconcile manually", { reference, transactionId: transaction.id });
                await transactionDetailRepository.update(detail.id, { providerStatus: status, providerPayload: checkout });
                return true;
            }
            const wallet = await this.walletService.getOrCreateWallet(transaction.user);
            // What Fincra settled to our GHS balance (it keeps its fee, which we bear): that's what gets converted
            const settledGhs = settledGhsFromCheckout(checkout, transaction.amount);
            const credited = await withTransaction(async (tx) => {
                if (!(await this.claimStatus(transaction, TRANSACTION_STATUS.COMPLETED as TransactionStatus, { completedAt: new Date() }, tx))) return false;
                await this.creditWalletFromGhsCollection(transaction, detail, wallet.id, tx);
                await transactionDetailRepository.update(detail.id, { providerStatus: status, providerPayload: checkout }, tx);
                // Turn the cedis into naira at Fincra (booked against the NGN value credited above)
                await ghsConversionService.queueForReceipt({
                    transactionId: transaction.id,
                    ghsAmount: settledGhs,
                    bookedNgn: Math.round(((detail.fromAmount || 0) + (detail.feeAmount || 0)) * 100) / 100,
                }, tx);
                return true;
            });
            if (credited) {
                logger.info("Wallet credited from GHS collection", { userId: transaction.user, transactionId: transaction.id, ghsAmount: transaction.amount, settledGhs });
                ghsConversionService.kick(transaction.id);
            }
            return true;
        }

        await transactionDetailRepository.update(detail.id, { providerStatus: status || detail.providerStatus, providerPayload: checkout });
        if (status === 'failed' || status === 'expired' || status === 'cancelled') {
            await this.claimStatus(transaction, TRANSACTION_STATUS.FAILED as TransactionStatus, { failedAt: new Date() });
        }
        return true;
    };

    /** Check a processing GHS transaction with Fincra (the UI, payment-link page and sweeper use this) */
    public pollGhsStatus = async (transactionId: string): Promise<{ transaction?: any; providerStatus: string; message?: string }> => {
        const transaction = await transactionRepository.findById(transactionId);
        if (!transaction) return { providerStatus: "unknown", message: "Transaction not found" };
        const detail = await transactionDetailRepository.findByTransactionId(transaction.id);
        const current = async (message?: string) => {
            const view = await transactionRepository.findViewById(transactionId);
            return { transaction: view, providerStatus: view?.details?.providerStatus || String(view?.status || "unknown"), message };
        };
        if (!detail?.providerReference) return current("This transaction has no payment reference yet.");
        // One-time GHS accounts: Spotflow's webhook is the only source; nothing to ask Fincra
        if (transaction.detailType === DETAIL_TYPE.SPOTFLOW) return current();

        if (detail.checkoutUrl || (detail.providerPayload as any)?.directCharge === true) {
            await this.handleFincraCheckout(detail.providerReference);
            // A link the payer never paid stops being checked after two days
            const fresh = await transactionRepository.findById(transactionId);
            const ageMs = Date.now() - new Date(transaction.createdAt).getTime();
            if (fresh && (fresh.status === TRANSACTION_STATUS.PENDING || fresh.status === TRANSACTION_STATUS.PROCESSING) && ageMs > 48 * 60 * 60 * 1000) {
                await this.claimStatus(fresh, TRANSACTION_STATUS.FAILED as TransactionStatus, { failedAt: new Date() });
                await transactionDetailRepository.update(detail.id, { providerStatus: 'expired' });
            }
            return current();
        }
        const payout = await fincraService.getPayout(detail.providerReference);
        if (!payout) {
            // Never reached Fincra: refund once it's clearly not just slow to appear
            const ageMs = Date.now() - new Date(transaction.createdAt).getTime();
            if (ageMs > 10 * 60 * 1000) {
                await this.handleFincraPayout({ customerReference: detail.providerReference, status: 'failed', reason: 'Not received by the payment provider' });
            }
            return current();
        }
        await this.handleFincraPayout({ ...payout, customerReference: detail.providerReference });
        return current();
    };

    /**
     * Transactions with their details and owner, newest first. `searchTerm`
     * matches the reference (partial, case-insensitive).
     */
    public async listTransactions(filter: TransactionListFilter, page: PageRequest, searchTerm?: string): Promise<Paginated<TransactionView>> {
        const search = searchTerm?.trim();
        return transactionRepository.paginateViews({ ...filter, ...(search ? { search } : {}) }, page);
    }

    /** The user's transactions and wallet fundings, paged together */
    /** One user's history, or (no user: admins) everyone's */
    public async listHistory(filter: TransactionListFilter, page: PageRequest, searchTerm?: string) {
        const search = searchTerm?.trim();
        return transactionRepository.paginateHistory({ ...filter, ...(search ? { search } : {}) }, page);
    }

    /** A transaction with its details and owner */
    public async findView(transactionId: string): Promise<TransactionView | undefined> {
        return transactionRepository.findViewById(transactionId);
    }

    /** The detail row of a transaction */
    public async findDetails(transactionId: string): Promise<TransactionDetail | undefined> {
        return transactionDetailRepository.findByTransactionId(transactionId);
    }

    /**
     * Claims the idempotency key, or returns the transaction it already
     * created (with its details and owner) when the request is a repeat.
     */
    private async findDuplicate(idempotencyKey: string, userId: string): Promise<TransactionView | undefined> {
        const idempotencyResult = await this.idempotencyService.validateKey(idempotencyKey, userId);
        if (!idempotencyResult.isDuplicate || !idempotencyResult.transactionId) return undefined;
        const existing = await transactionRepository.findViewById(idempotencyResult.transactionId);
        if (!existing) return undefined;
        return { ...existing, details: existing.details ?? ({} as TransactionDetail) };
    }
}

export type { TransactionListFilter };
export default TransactionService;
