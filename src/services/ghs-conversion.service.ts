import fincraService, { FincraError } from "./fincra.service";
import fxConversionRepository, { type FxConversion } from "../repositories/fx-conversion.repository";
import ledgerService from "./ledger.service";
import { withTransaction } from "../db/transaction";
import type { Executor } from "../db/client";
import { JOURNAL_DIRECTION, JOURNAL_SOURCE, SYSTEM_ACCOUNT_CODES, WEBHOOK_PROVIDER, fincraCashCode } from "../common/constant";
import NotificationService from "../utils/notification.utils";
import config from "../config/env.config";
import logger from "../utils/logger.utils";

const round2 = (n: number) => Math.round(n * 100) / 100;
const MINUTE = 60 * 1000;

/** Waits between attempts to start a conversion (Fincra may not have settled the GHS yet): about 2 days in all */
const RETRY_DELAYS_MIN = [2, 5, 15, 30, 60, 120, 240, 480, 720, 1440];
/** How often a started conversion is checked, and when to stop waiting for it */
const CHECK_EVERY_MIN = 2;
/** A conversion still unsettled this long after the receipt is handed to a person */
const GIVE_UP_CHECKING_MS = 4 * 24 * 60 * MINUTE;

/**
 * Every GHS payment-link receipt at Fincra is converted to NGN once it's
 * confirmed, so the cedis don't pile up while users' naira is paid from the
 * NGN balance. The user's wallet was credited already at the locked rate;
 * this only moves our own money between Fincra balances.
 *
 * Books, in NGN: the GHS cash comes off at the value it was booked at, NGN
 * cash goes up by what Fincra gives, and the difference is FX gain or loss.
 */
class GhsConversionService {
    private notifications = new NotificationService();

    get enabled(): boolean {
        return config.FINCRA_AUTO_CONVERT_GHS;
    }

    /** Queues the conversion for a receipt, in the same database transaction as the credit */
    async queueForReceipt(input: { transactionId: string; ghsAmount: number; bookedNgn: number }, tx: Executor): Promise<void> {
        if (!this.enabled || !(input.ghsAmount > 0)) return;
        await fxConversionRepository.queue({
            transactionId: input.transactionId,
            provider: WEBHOOK_PROVIDER.FINCRA,
            sourceCurrency: "GHS",
            destinationCurrency: "NGN",
            sourceAmount: round2(input.ghsAmount),
            bookedNgn: round2(input.bookedNgn),
        }, tx);
    }

    /** Starts a receipt's conversion now, in the background (the sweeper retries if this fails) */
    kick(transactionId: string): void {
        if (!this.enabled) return;
        Promise.resolve()
            .then(async () => {
                const conversion = await fxConversionRepository.findByTransaction(transactionId);
                if (conversion) await this.process(conversion);
            })
            .catch((error) => logger.warn("GHS conversion: background start failed", { transactionId, error: error?.message }));
    }

    /** The sweeper: start, retry or check every conversion that's due */
    async processDue(now = new Date()): Promise<{ due: number }> {
        if (!this.enabled) return { due: 0 };
        const due = await fxConversionRepository.listDue(25, now);
        for (const conversion of due) {
            try {
                await this.process(conversion, now);
            } catch (error: any) {
                logger.warn("GHS conversion: processing failed", { conversionId: conversion.id, error: error?.message });
            }
        }
        return { due: due.length };
    }

    /** Fincra's conversion.successful webhook */
    async handleWebhook(reference: string): Promise<boolean> {
        const conversion = await fxConversionRepository.findByProviderReference(reference);
        if (!conversion) return false;
        if (conversion.status === "processing") await this.check(conversion);
        return true;
    }

    async process(conversion: FxConversion, now = new Date()): Promise<void> {
        if (conversion.status === "pending") return this.start(conversion, now);
        if (conversion.status === "processing") return this.check(conversion, now);
    }

    private async start(conversion: FxConversion, now = new Date()): Promise<void> {
        const attempt = conversion.attempts + 1;
        const customerReference = `CNV-${conversion.transactionId.slice(0, 8)}-${conversion.id.slice(0, 8)}-${attempt}`;
        // A lease: if this attempt dies midway, it's picked up again in a few minutes
        const claimed = await fxConversionRepository.claimAttempt(conversion.id, conversion.attempts, {
            attempts: attempt,
            customerReference,
            nextAttemptAt: new Date(now.getTime() + 5 * MINUTE),
        });
        if (!claimed) return;
        try {
            const started = await fincraService.convert({
                sourceCurrency: conversion.sourceCurrency,
                destinationCurrency: conversion.destinationCurrency,
                amount: Number(conversion.sourceAmount),
                customerReference,
            });
            await fxConversionRepository.update(conversion.id, {
                status: "processing",
                providerReference: started.reference,
                quoteReference: started.quote.reference,
                lastError: null,
                nextAttemptAt: new Date(now.getTime() + CHECK_EVERY_MIN * MINUTE),
            });
            logger.info("GHS conversion started", { conversionId: conversion.id, transactionId: conversion.transactionId, ghs: conversion.sourceAmount, reference: started.reference });
            const current = await fxConversionRepository.findById(conversion.id);
            if (current) await this.check(current, now);
        } catch (error: any) {
            const message = error instanceof FincraError ? error.message : String(error?.message || error);
            if (attempt > RETRY_DELAYS_MIN.length) {
                await fxConversionRepository.update(conversion.id, { status: "failed", lastError: message.slice(0, 500) });
                logger.error("CRITICAL: GHS conversion gave up; convert it on the Fincra dashboard", { conversionId: conversion.id, transactionId: conversion.transactionId, error: message });
                this.alert(conversion, `Converting GHS ${conversion.sourceAmount} to NGN kept failing (${message}). Please convert it on the Fincra dashboard.`);
                return;
            }
            const delay = RETRY_DELAYS_MIN[attempt - 1];
            await fxConversionRepository.update(conversion.id, { lastError: message.slice(0, 500), nextAttemptAt: new Date(now.getTime() + delay * MINUTE) });
            logger.warn("GHS conversion: attempt failed, will retry", { conversionId: conversion.id, attempt, retryInMinutes: delay, error: message });
        }
    }

    /** Asks Fincra how a started conversion went, and books it when it's done */
    private async check(conversion: FxConversion, now = new Date()): Promise<void> {
        if (!conversion.providerReference) return;
        let result: Awaited<ReturnType<typeof fincraService.getConversion>>;
        try {
            result = await fincraService.getConversion(conversion.providerReference);
        } catch (error: any) {
            if (!(error instanceof FincraError && error.status === 404)) throw error;
            result = null; // not visible yet
        }
        const status = String(result?.status || "").toLowerCase();

        if (status === "successful" || status === "success" || status === "completed") {
            const received = round2(Number(result?.amountReceived));
            if (!(received > 0)) {
                logger.error("GHS conversion reported done without an amount", { conversionId: conversion.id, result });
                return;
            }
            const charged = Number(result?.amountCharged) || Number(conversion.sourceAmount);
            const rate = charged > 0 ? Math.round((received / charged) * 1_000_000) / 1_000_000 : undefined;
            await this.book(conversion, received, rate);
            return;
        }

        if (status === "failed" || status === "cancelled" || status === "declined" || status === "reversed") {
            // Start again with a new reference (the GHS is still in the balance)
            const tooMany = conversion.attempts > RETRY_DELAYS_MIN.length;
            await fxConversionRepository.updateIfStatus(conversion.id, "processing", {
                status: tooMany ? "failed" : "pending",
                providerReference: null,
                lastError: `Fincra ${status}${result?.message ? `: ${result.message}` : ""}`.slice(0, 500),
                nextAttemptAt: new Date(now.getTime() + (RETRY_DELAYS_MIN[Math.min(conversion.attempts, RETRY_DELAYS_MIN.length) - 1] ?? 5) * MINUTE),
            });
            if (tooMany) this.alert(conversion, `Fincra kept refusing to convert GHS ${conversion.sourceAmount} to NGN. Please convert it on the Fincra dashboard.`);
            return;
        }

        // Still going: look again shortly, but not for ever
        const startedAt = new Date(conversion.createdAt).getTime();
        if (now.getTime() - startedAt > GIVE_UP_CHECKING_MS) {
            await fxConversionRepository.updateIfStatus(conversion.id, "processing", { status: "failed", lastError: `Still ${status || "unknown"} at Fincra after 4 days` });
            this.alert(conversion, `A GHS → NGN conversion (${conversion.providerReference}) has been pending at Fincra for 4 days. Please check it on the Fincra dashboard.`);
            return;
        }
        await fxConversionRepository.update(conversion.id, { nextAttemptAt: new Date(now.getTime() + CHECK_EVERY_MIN * MINUTE) });
    }

    /** Marks it done and books it, once */
    private async book(conversion: FxConversion, receivedNgn: number, rate?: number): Promise<void> {
        const booked = round2(Number(conversion.bookedNgn));
        const difference = round2(receivedNgn - booked);
        await withTransaction(async (tx) => {
            const claimed = await fxConversionRepository.updateIfStatus(conversion.id, "processing", {
                status: "successful",
                amountReceived: receivedNgn,
                ...(rate !== undefined ? { rate } : {}),
                completedAt: new Date(),
                lastError: null,
            }, tx);
            if (!claimed) return;
            const legs = [
                { accountCode: fincraCashCode("NGN"), direction: JOURNAL_DIRECTION.DEBIT, amount: receivedNgn },
                { accountCode: fincraCashCode("GHS"), direction: JOURNAL_DIRECTION.CREDIT, amount: booked },
            ];
            if (difference > 0) legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FX_CONVERSION_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: difference });
            if (difference < 0) legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FX_CONVERSION_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: -difference });
            await ledgerService.post({
                legs,
                source: JOURNAL_SOURCE.FX_CONVERSION,
                reference: conversion.customerReference || conversion.id,
                description: `GHS ${conversion.sourceAmount} converted to ₦${receivedNgn.toLocaleString("en-US")} at Fincra`,
                externalRef: { provider: WEBHOOK_PROVIDER.FINCRA, id: `conversion:${conversion.providerReference}` },
                metadata: { conversionId: conversion.id, transactionId: conversion.transactionId, ghs: conversion.sourceAmount, booked, received: receivedNgn, rate },
                tx,
            });
        });
        logger.info("GHS conversion booked", { conversionId: conversion.id, ghs: conversion.sourceAmount, receivedNgn, booked, difference });
    }

    private alert(conversion: FxConversion, message: string) {
        Promise.resolve().then(() => this.notifications.notifyAdmins(config.ADMIN_EMAILS, {
            title: "GHS conversion needs attention",
            message: `${message} (transaction ${conversion.transactionId})`,
        } as any, config.ADMIN_PHONE_NUMBERS)).catch(() => undefined);
    }
}

export default new GhsConversionService();
