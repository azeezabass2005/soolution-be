import { and, count, desc, eq, isNotNull, isNull, type SQL } from "drizzle-orm";
import { ledgerAlerts, reconciliationReports } from "../db/schema";
import type { LedgerAlert, ReconciliationReport } from "../types/entities";
import type { LedgerAlertSeverity } from "../types/enums";
import { pageWindow, toPage, type PageRequest, type Paginated } from "../db/pagination";
import { exec, isUuid, stripNulls } from "./utils";

export type NewReconciliationReport = typeof reconciliationReports.$inferInsert;
export type NewLedgerAlert = typeof ledgerAlerts.$inferInsert;

export interface LedgerAlertFilter {
    severity?: string;
    code?: string;
    acknowledged?: boolean;
}

class ReconciliationRepository {
    async createReport(data: NewReconciliationReport): Promise<ReconciliationReport> {
        const [row] = await exec().insert(reconciliationReports).values(data).returning();
        return stripNulls(row);
    }

    async findReport(id: string): Promise<ReconciliationReport | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec().select().from(reconciliationReports).where(eq(reconciliationReports.id, id)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /** Newest first */
    async paginateReports(request: PageRequest): Promise<Paginated<ReconciliationReport>> {
        const window = pageWindow(request, { limit: 20 });
        const [rows, [{ n }]] = await Promise.all([
            exec().select().from(reconciliationReports).orderBy(desc(reconciliationReports.startedAt), desc(reconciliationReports.id)).limit(window.limit).offset(window.offset),
            exec().select({ n: count() }).from(reconciliationReports),
        ]);
        return toPage(rows.map(stripNulls), Number(n), window);
    }

    async createAlert(data: NewLedgerAlert): Promise<LedgerAlert> {
        const [row] = await exec().insert(ledgerAlerts).values(data).returning();
        return stripNulls(row);
    }

    /** Newest first */
    async paginateAlerts(filter: LedgerAlertFilter, request: PageRequest): Promise<Paginated<LedgerAlert>> {
        const window = pageWindow(request, { limit: 25 });
        const where: SQL[] = [];
        if (filter.severity) where.push(eq(ledgerAlerts.severity, filter.severity as LedgerAlertSeverity));
        if (filter.code) where.push(eq(ledgerAlerts.code, filter.code));
        if (filter.acknowledged === false) where.push(isNull(ledgerAlerts.acknowledgedAt));
        if (filter.acknowledged === true) where.push(isNotNull(ledgerAlerts.acknowledgedAt));
        const condition = where.length ? and(...where) : undefined;
        const [rows, [{ n }]] = await Promise.all([
            exec().select().from(ledgerAlerts).where(condition).orderBy(desc(ledgerAlerts.createdAt), desc(ledgerAlerts.id)).limit(window.limit).offset(window.offset),
            exec().select({ n: count() }).from(ledgerAlerts).where(condition),
        ]);
        return toPage(rows.map(stripNulls), Number(n), window);
    }

    async acknowledgeAlert(id: string, by: string | undefined): Promise<LedgerAlert | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec()
            .update(ledgerAlerts)
            .set({ acknowledgedAt: new Date(), acknowledgedBy: isUuid(by) ? by : null })
            .where(eq(ledgerAlerts.id, id))
            .returning();
        return row ? stripNulls(row) : undefined;
    }
}

export const reconciliationRepository = new ReconciliationRepository();
export default reconciliationRepository;
