import config from "../config/env.config";
import logger from "../utils/logger.utils";
import fincraService, { FINCRA_CHECKOUT_FINAL, FincraError } from "./fincra.service";
import spotflowService, { SPOTFLOW_CURRENCIES } from "./spotflow.service";
import dayaService from "./daya.service";

/**
 * Checks the lab providers after something is done in a lab tab, so nothing
 * depends on webhooks (which can't reach a local machine) and nothing is
 * polled when nobody is doing anything.
 *
 * - Creating an account or a payment link, or opening an account's deposits
 *   or balance, watches it for LAB_WATCH_MINUTES. Doing it again restarts
 *   the clock. A payment link stops being watched once it's paid, failed or
 *   expired.
 * - A Fincra deposit still processing keeps its account watched until it
 *   settles or fails (up to a day).
 * - "Check now" checks every account once and doesn't keep polling.
 * - With nothing watched, no timer runs and no calls are made.
 *
 * It only reads. Seen deposits and balances live in memory (not the shared
 * database); the provider stays the source of truth.
 */

export type LabProvider = "fincra" | "spotflow" | "daya";

export interface LabEvent {
    id: number;
    provider: LabProvider;
    kind: "deposit" | "status_change" | "balance_change";
    at: string;
    account: string;
    currency: string;
    amount?: number;
    fee?: number;
    settled?: number;
    status?: string;
    previousStatus?: string;
    balance?: number;
    reference?: string;
    sender?: string;
    note?: string;
}

/** A Fincra payment link created from the tab, and what the last check said */
export interface LabCheckout {
    reference: string;
    link: string;
    currency: string;
    amount: number;
    customerName: string;
    paymentMethods: string[];
    feeBearer: string;
    feeEstimate?: { fee?: number; vat?: number; method: string } | null;
    createdAt: string;
    status: string;
    amountReceived?: number;
    varianceType?: string | null;
    message?: string;
    lastCheckedAt?: string;
}

interface Watch {
    /** What the tab shows: account number, or "main GHS balance" */
    label: string;
    until: number;
}

interface ProviderState {
    running: boolean;
    lastPolledAt: string | null;
    lastError: string | null;
    events: LabEvent[];
    /** key → watch; Fincra keys are VA ids or checkout:<reference>, Spotflow keys are account ids */
    watches: Map<string, Watch>;
}

const MAX_EVENTS = 200;
/** A processing deposit keeps its account watched at most this long */
const PENDING_CAP_MS = 24 * 60 * 60 * 1000;
const FINAL_STATUSES = new Set(["successful", "failed"]);
/** Accounts checked at the same time, so a big business doesn't flood the provider */
const CONCURRENCY = 5;
/** Runs fn over items, a few at a time; the first failure fails the check */
const eachLimited = async <T>(items: T[], fn: (item: T) => Promise<void>) => {
    let next = 0;
    const worker = async () => {
        while (next < items.length) await fn(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
};
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : undefined);

class LabPollerService {
    private timer: NodeJS.Timeout | null = null;
    private nextId = 1;
    private state: Record<LabProvider, ProviderState> = {
        fincra: this.blank(),
        spotflow: this.blank(),
        daya: this.blank(),
    };
    /** Fincra VA id → account number */
    private fincraNumbers = new Map<string, string>();
    /** Fincra deposit reference → last status seen */
    private fincraDeposits = new Map<string, string>();
    /** Fincra VA ids whose existing deposits have been learnt */
    private fincraKnown = new Set<string>();
    /** Spotflow account id → the account number people pay into */
    private spotflowLabels = new Map<string, string>();
    /** Spotflow transaction id → last status seen */
    private spotflowTransactions = new Map<string, string>();
    /** Spotflow account ids whose existing transactions have been learnt */
    private spotflowKnown = new Set<string>();
    /** Payment links created from the tab since the backend started */
    private checkouts = new Map<string, LabCheckout>();
    /** Daya watch key (fa:<funding account id> or va:<virtual account id>) → account number shown */
    private dayaLabels = new Map<string, string>();
    /** Daya deposit id → last status seen */
    private dayaDeposits = new Map<string, string>();
    /** Daya watch keys whose existing deposits have been learnt */
    private dayaKnown = new Set<string>();
    /** Accounts opened from the tab: everything paid into them is new, so they count from zero */
    private fresh = new Set<string>();

    private blank(): ProviderState {
        return { running: false, lastPolledAt: null, lastError: null, events: [], watches: new Map() };
    }

    get intervalSeconds() {
        return config.LAB_POLL_SECONDS;
    }

    private get windowMs() {
        return config.LAB_WATCH_MINUTES * 60_000;
    }

    private enabled(provider: LabProvider) {
        if (provider === "fincra") return config.FINCRA_LAB_ENABLED && fincraService.configured;
        if (provider === "daya") return config.DAYA_LAB_ENABLED && dayaService.configured && !!dayaService.mode;
        return config.SPOTFLOW_LAB_ENABLED && spotflowService.configured && !!spotflowService.mode;
    }

    /* ---------------- actions that start watching ---------------- */

    watchFincraAccount(id: string, accountNumber?: string, { isNew = false } = {}) {
        if (!id) return;
        if (accountNumber) this.fincraNumbers.set(id, accountNumber);
        if (isNew) this.fresh.add(`fincra:${id}`);
        this.arm("fincra", id, accountNumber || id);
    }

    /** Spotflow balances are looked up by account id; the label is the number people pay into */
    watchSpotflowAccount(id: string, accountNumber?: string, { isNew = false } = {}) {
        if (!id) return;
        if (accountNumber) this.spotflowLabels.set(id, accountNumber);
        if (isNew) this.fresh.add(`spotflow:${id}`);
        this.arm("spotflow", id, this.spotflowLabels.get(id) || id);
    }

    /**
     * A Daya NGN funding account ("fa") or USD/EUR virtual account ("va").
     * The label is the account number people pay into.
     */
    watchDayaAccount(kind: "fa" | "va", id: string, label?: string, { isNew = false } = {}) {
        if (!id) return;
        const key = `${kind}:${id}`;
        if (label) this.dayaLabels.set(key, label);
        if (isNew) this.fresh.add(`daya:${key}`);
        this.arm("daya", key, this.dayaLabels.get(key) || id);
    }

    /** A just-created payment link; watched until it's paid, failed or expired */
    trackCheckout(checkout: LabCheckout) {
        this.checkouts.set(checkout.reference, checkout);
        this.arm("fincra", `checkout:${checkout.reference}`, `payment link ${checkout.reference}`);
    }

    listCheckouts() {
        return [...this.checkouts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    /** Re-reads one link's status from Fincra; checking a link also watches it until it's final */
    async refreshCheckout(reference: string, { watch = true } = {}) {
        const c = this.checkouts.get(reference);
        let data: any;
        try {
            data = await fincraService.getCheckout(reference);
        } catch (error) {
            // Fincra may not know the link until the payer opens it
            if (error instanceof FincraError && error.status === 404) {
                if (c) c.lastCheckedAt = new Date().toISOString();
                return c ?? null;
            }
            throw error;
        }
        if (!data) return c ?? null;
        const status = String(data.status || "unknown");
        const record: LabCheckout = c ?? {
            reference,
            link: "",
            currency: data.currency,
            amount: num(data.amount) ?? 0,
            customerName: data.customer?.name || "",
            paymentMethods: data.paymentMethods || [],
            feeBearer: data.feeBearer || "",
            createdAt: data.createdAt || new Date().toISOString(),
            status: "created",
        };
        const previous = record.status;
        Object.assign(record, {
            status,
            amountReceived: num(data.amountReceived),
            varianceType: data.varianceType ?? null,
            message: data.message,
            lastCheckedAt: new Date().toISOString(),
        });
        this.checkouts.set(reference, record);
        if (previous !== status) {
            this.record({
                provider: "fincra",
                kind: "status_change",
                account: `payment link ${reference}`,
                currency: record.currency,
                amount: record.amount,
                settled: record.amountReceived,
                status,
                previousStatus: previous,
                reference,
                sender: data.customer?.name,
                note: data.varianceType ? `${data.varianceType}${data.message ? ` (${data.message})` : ""}` : undefined,
            });
        }
        const key = `checkout:${reference}`;
        if (FINCRA_CHECKOUT_FINAL.has(status)) {
            this.state.fincra.watches.delete(key);
            this.syncTimer();
        } else if (watch && !this.state.fincra.watches.has(key)) {
            this.arm("fincra", key, `payment link ${reference}`, false);
        }
        return record;
    }

    stopWatching(provider: LabProvider) {
        this.state[provider].watches.clear();
        this.syncTimer();
    }

    private arm(provider: LabProvider, key: string, label: string, checkNow = true) {
        if (!this.enabled(provider)) return;
        this.state[provider].watches.set(key, { label, until: Date.now() + this.windowMs });
        this.syncTimer();
        // Check straight away so the starting point is known before money arrives
        if (checkNow) void this.run(provider, () => this.poll(provider, false));
    }

    /** A timer exists only while something is being watched */
    private syncTimer() {
        const any = this.state.fincra.watches.size + this.state.spotflow.watches.size + this.state.daya.watches.size > 0;
        if (any && !this.timer) {
            this.timer = setInterval(() => void this.tick(), this.intervalSeconds * 1000);
            logger.info("Lab watch started", { everySeconds: this.intervalSeconds });
        } else if (!any && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            logger.info("Lab watch stopped: nothing left to watch");
        }
    }

    private expire(provider: LabProvider) {
        const now = Date.now();
        for (const [key, w] of this.state[provider].watches) if (w.until <= now) this.state[provider].watches.delete(key);
    }

    /* ---------------- polling ---------------- */

    async tick() {
        for (const provider of ["fincra", "spotflow", "daya"] as LabProvider[]) {
            this.expire(provider);
            if (this.state[provider].watches.size) await this.run(provider, () => this.poll(provider, false));
        }
        this.syncTimer();
    }

    /** "Check now": every account once, without starting a watch */
    async checkAll(provider: LabProvider) {
        if (!this.enabled(provider)) return;
        await this.run(provider, () => this.poll(provider, true));
    }

    status(provider: LabProvider) {
        this.expire(provider);
        const s = this.state[provider];
        return {
            everySeconds: this.intervalSeconds,
            watchMinutes: config.LAB_WATCH_MINUTES,
            active: this.enabled(provider),
            watching: [...s.watches.values()].map((w) => ({ label: w.label, until: new Date(w.until).toISOString() })),
            lastPolledAt: s.lastPolledAt,
            lastError: s.lastError,
            events: s.events,
        };
    }

    /** One check at a time per provider; a failure is recorded and the next check tries again */
    private async run(provider: LabProvider, poll: () => Promise<void>) {
        const s = this.state[provider];
        if (s.running) return;
        s.running = true;
        try {
            await poll();
            s.lastError = null;
        } catch (error: any) {
            s.lastError = error?.message || String(error);
            logger.warn("Lab check failed", { provider, error: s.lastError });
        } finally {
            s.lastPolledAt = new Date().toISOString();
            s.running = false;
        }
    }

    private poll(provider: LabProvider, all: boolean) {
        if (provider === "fincra") return this.pollFincra(all);
        if (provider === "daya") return this.pollDaya(all);
        return this.pollSpotflow(all);
    }

    private record(event: Omit<LabEvent, "id" | "at">) {
        const s = this.state[event.provider];
        s.events.unshift({ id: this.nextId++, at: new Date().toISOString(), ...event });
        s.events.length = Math.min(s.events.length, MAX_EVENTS);
        logger.info("Lab check found a change", event);
    }

    /**
     * New deposits, and deposits whose status moved (processing →
     * successful). The first look at an account only learns what's there,
     * unless the account was just opened from the tab.
     */
    private async pollFincra(all: boolean) {
        const linkRefs = all
            ? this.listCheckouts().filter((c) => !FINCRA_CHECKOUT_FINAL.has(c.status)).map((c) => c.reference)
            : [...this.state.fincra.watches.keys()].filter((k) => k.startsWith("checkout:")).map((k) => k.slice(9));
        await eachLimited(linkRefs, async (ref) => {
            await this.refreshCheckout(ref, { watch: false });
        });

        let targets: Array<{ id: string; number?: string }>;
        if (all) {
            const { accounts } = await fincraService.listVirtualAccounts();
            targets = accounts
                .map((a: any) => ({ id: a._id || a.id, number: a.accountInformation?.accountNumber || a.accountNumber }))
                .filter((t: any) => t.id && t.number);
            targets.forEach((t) => this.fincraNumbers.set(t.id, t.number as string));
        } else {
            targets = [...this.state.fincra.watches.keys()].filter((k) => !k.startsWith("checkout:")).map((id) => ({ id, number: this.fincraNumbers.get(id) }));
        }

        await eachLimited(targets, async ({ id, number }) => {
            const deposits = await fincraService.listDeposits(id, number);
            const known = this.fincraKnown.has(id) || this.fresh.has(`fincra:${id}`);
            let pending = false;
            for (const d of deposits) {
                const ref = d.reference || d._id || d.id;
                if (!ref) continue;
                const status = String(d.status || "unknown");
                if (!FINAL_STATUSES.has(status)) pending = true;
                const seen = this.fincraDeposits.get(ref);
                this.fincraDeposits.set(ref, status);
                if (!known || seen === status) continue;
                this.record({
                    provider: "fincra",
                    kind: seen === undefined ? "deposit" : "status_change",
                    account: number || id,
                    currency: d.destinationCurrency || d.sourceCurrency || "NGN",
                    amount: num(d.sourceAmount ?? d.amount),
                    fee: num(d.fee),
                    settled: num(d.amountReceived),
                    status,
                    previousStatus: seen,
                    reference: ref,
                    sender: d.senderAccountName || d.customerName,
                });
            }
            this.fincraKnown.add(id);
            // Keep watching until a processing deposit settles or fails
            const watch = this.state.fincra.watches.get(id);
            if (pending && watch) watch.until = Math.max(watch.until, Math.min(Date.now() + this.windowMs, Date.now() + PENDING_CAP_MS));
        });
    }

    /**
     * New credits and debits on each watched account (a permanent account,
     * or the main account one-time accounts pay into), and any whose status
     * changes. The first look at an account only learns what's there, unless
     * the account was just opened from the tab.
     */
    private async pollSpotflow(all: boolean) {
        let ids = [...this.state.spotflow.watches.keys()];
        if (all) {
            const accounts: any[] = [];
            for (const currency of SPOTFLOW_CURRENCIES) accounts.push(...(await spotflowService.listStaticAccounts(currency)));
            for (const a of accounts) if (a.id && a.accountDetails?.accountNumber) this.spotflowLabels.set(a.id, a.accountDetails.accountNumber);
            const mains = (await spotflowService.mainBalances()).filter((b: any) => b.accountId && SPOTFLOW_CURRENCIES.includes(b.currency));
            for (const b of mains) this.spotflowLabels.set(b.accountId, `main ${b.currency} balance`);
            ids = [...accounts.map((a) => a.id), ...mains.map((b: any) => b.accountId)].filter(Boolean);
        }
        await eachLimited(ids, async (id) => {
            const { transactions } = await spotflowService.listTransactions(id);
            const known = this.spotflowKnown.has(id) || this.fresh.has(`spotflow:${id}`);
            for (const t of transactions) {
                if (!t.id) continue;
                const status = String(t.status || "unknown");
                const seen = this.spotflowTransactions.get(t.id);
                this.spotflowTransactions.set(t.id, status);
                if (!known || seen === status) continue;
                this.record({
                    provider: "spotflow",
                    kind: seen === undefined ? "deposit" : "status_change",
                    account: this.spotflowLabels.get(id) || id,
                    currency: t.currency,
                    amount: num(t.amount),
                    fee: num(t.fee),
                    status,
                    previousStatus: seen,
                    reference: t.reference,
                    sender: t.sender?.name,
                    note: t.type === "debit" ? "money out" : undefined,
                });
            }
            this.spotflowKnown.add(id);
        });
    }

    /**
     * New Daya deposits, and deposits whose status moves (received →
     * completed). NGN deposits come from one list (Daya can't filter it by
     * account), USD/EUR ones from each virtual account. The first look at an
     * account only learns what's there, unless it was just opened from the tab.
     */
    private async pollDaya(all: boolean) {
        let keys = [...this.state.daya.watches.keys()];
        if (all) {
            const [fas, vas] = await Promise.all([dayaService.listFundingAccounts(), dayaService.listVirtualAccounts()]);
            for (const a of fas) {
                const n = (a.instructions || []).find((i: any) => i.account_number)?.account_number;
                if (n) this.dayaLabels.set(`fa:${a.id}`, n);
            }
            for (const v of vas) {
                const n = v.deposit_instructions?.bank_account_number || v.deposit_instructions?.iban;
                if (n) this.dayaLabels.set(`va:${v.id}`, n);
            }
            keys = [...fas.map((a: any) => `fa:${a.id}`), ...vas.map((v: any) => `va:${v.id}`)];
        }

        const byKey = new Map<string, any[]>();
        if (keys.some((k) => k.startsWith("fa:"))) {
            // Three days back covers anything still settling
            const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
            for (const d of await dayaService.listDeposits(from)) {
                if (!d.funding_account_id) continue;
                const k = `fa:${d.funding_account_id}`;
                byKey.set(k, [...(byKey.get(k) || []), d]);
            }
        }
        await eachLimited(keys.filter((k) => k.startsWith("va:")), async (k) => {
            byKey.set(k, await dayaService.listVirtualAccountDeposits(k.slice(3)));
        });

        for (const key of keys) {
            const known = this.dayaKnown.has(key) || this.fresh.has(`daya:${key}`);
            let pending = false;
            for (const d of byKey.get(key) || []) {
                if (!d.id) continue;
                const status = String(d.status || "unknown");
                if (!["COMPLETED", "FAILED", "REVERSED"].includes(status)) pending = true;
                const seen = this.dayaDeposits.get(d.id);
                this.dayaDeposits.set(d.id, status);
                if (!known || seen === status) continue;
                const currency = d.currency || (key.startsWith("va:") ? "USD" : "NGN");
                const depositFee = d.fees?.deposit_fee;
                const notes = [
                    d.source_amount ? `paid ${d.source_amount} ${d.source_currency}` : "",
                    d.settled_amount && d.settled_currency && d.settled_currency !== currency ? `settled ${d.settled_amount} ${d.settled_currency}` : "",
                    depositFee && depositFee.currency !== currency ? `fee ${depositFee.amount} ${depositFee.currency}` : "",
                    !depositFee && d.fees?.total_fee_usd ? `fee ${d.fees.total_fee_usd} USD` : "",
                    d.flag_message || "",
                ].filter(Boolean);
                this.record({
                    provider: "daya",
                    kind: seen === undefined ? "deposit" : "status_change",
                    account: this.dayaLabels.get(key) || key.slice(3),
                    currency,
                    amount: num(d.amount),
                    fee: depositFee && depositFee.currency === currency ? num(depositFee.amount) : undefined,
                    settled: d.settled_currency === currency ? num(d.settled_amount) : undefined,
                    status,
                    previousStatus: seen,
                    reference: d.id,
                    sender: d.sender?.name,
                    note: notes.join(" · ") || undefined,
                });
            }
            this.dayaKnown.add(key);
            const watch = this.state.daya.watches.get(key);
            if (pending && watch) watch.until = Math.max(watch.until, Math.min(Date.now() + this.windowMs, Date.now() + PENDING_CAP_MS));
        }
    }
}

export default new LabPollerService();
