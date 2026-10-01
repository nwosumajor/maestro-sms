// =============================================================================
// Ledger integrity — find invoices whose STATUS disagrees with their MONEY
// =============================================================================
// An invoice's status is a LABEL derived from its payments by one rule
// (`invoiceStatusForNet`). Every app writer applies it; nothing in the database
// enforces it. So a label can drift, and nothing would ever notice: a live
// database held an invoice marked PAID with ₦1,000 of ₦1,500 unpaid, because a
// direct superuser DELETE (a probe cleanup) removed the scholarship payment
// that had paid it. The app role cannot delete a payment; the label was right
// when it was written and wrong ever after, and every screen believed it.
//
// Both directions cost somebody: PAID-but-owing stops the reminders and reads as
// settled; OPEN-but-settled chases a family for a bill they have paid.
//
// This DETECTS — nightly and on demand, across the fleet — and offers ONE
// correction: re-derive the label from the ledger. It never moves money and
// never touches a payment; it makes the label say what the money already says.
// =============================================================================

import { ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import type {
  LedgerIntegrityResult,
  LedgerMismatchDto,
  LedgerMismatchKind,
  LedgerMismatchPageDto,
  LedgerRederiveResultDto,
} from "@sms/types";
import { LEDGER_MISMATCH_KINDS } from "@sms/types";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { NotificationService } from "../notifications/notification.service";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { invoiceStatusForNet } from "./net-paid";

export const LEDGER_INTEGRITY_QUEUE = "ledger-integrity";
export const LEDGER_INTEGRITY_JOB = "ledger-integrity-sweep";
export const LEDGER_INTEGRITY_SCHEDULER_ID = "ledger-integrity-daily";
/** 04:40 — after reconciliation (04:10) has posted anything it recovered. */
export const DEFAULT_LEDGER_INTEGRITY_CRON = "40 4 * * *";

/** One page of the operator listing. */
export const LEDGER_MISMATCH_PAGE = 50;

/** Finance roles at a school — told when the platform corrects one of its labels. */
const FINANCE_ROLES = ["accountant", "school_admin", "principal"];

/**
 * The judged set, in SQL. The CASE is `invoiceStatusForNet` written for
 * Postgres — `ledger-integrity.e2e-spec` drives every combination through both
 * and fails if they disagree, so this cannot quietly become a second rule.
 *
 * Billable statuses only: a DRAFT is not a bill and a CANCELLED one is closed.
 * A zero-total invoice is left out — "nothing owed, nothing paid" is both ISSUED
 * and PAID by the arithmetic, and flagging it would be noise.
 */
function judgedSql(schoolId?: string): Prisma.Sql {
  const scope = schoolId ? Prisma.sql`AND i."schoolId" = ${schoolId}::uuid` : Prisma.empty;
  const payScope = schoolId ? Prisma.sql`AND p."schoolId" = ${schoolId}::uuid` : Prisma.empty;
  return Prisma.sql`
    WITH net AS (
      -- Uncorrelated, as the finance report's is: one aggregate over payments,
      -- not an index probe per invoice.
      SELECT p."invoiceId",
             SUM(CASE WHEN p.kind = 'REFUND' THEN -p."amountMinor"::numeric ELSE p."amountMinor"::numeric END) AS paid
        FROM payment p
       WHERE p.status = 'POSTED' ${payScope}
       GROUP BY 1
    ),
    judged AS (
      SELECT i.id, i."schoolId", i.reference, i.currency, i."totalMinor", i."updatedAt",
             i.status::text AS status,
             COALESCE(n.paid, 0) AS paid,
             CASE WHEN COALESCE(n.paid, 0) >= i."totalMinor" THEN 'PAID'
                  WHEN COALESCE(n.paid, 0) > 0 THEN 'PARTIALLY_PAID'
                  ELSE 'ISSUED' END AS derived
        FROM invoice i
        LEFT JOIN net n ON n."invoiceId" = i.id
       WHERE i.status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID')
         AND i."totalMinor" > 0
         ${scope}
    ),
    mismatched AS (
      SELECT judged.*,
             CASE WHEN status = 'PAID' THEN 'PAID_BUT_OWING'
                  WHEN derived = 'PAID' THEN 'OPEN_BUT_SETTLED'
                  ELSE 'PARTIAL_MISLABELLED' END AS kind
        FROM judged
       WHERE status <> derived
    )`;
}

@Injectable()
export class LedgerIntegrityService {
  private readonly logger = new Logger("LedgerIntegrity");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
  ) {}

  private client() {
    const c = this.privileged.client;
    if (!c) throw new ServiceUnavailableException("Ledger integrity requires the privileged database configuration");
    return c;
  }

  /**
   * Judge every billable invoice on the platform and report what disagrees.
   * Alerts the platform owners when anything does — every run while it lasts,
   * because a label that is wrong today is wrong tomorrow and is owed money.
   */
  async sweep(trigger: "SCHEDULED" | "MANUAL"): Promise<LedgerIntegrityResult> {
    const client = this.client();
    const [counts, scanned] = await Promise.all([
      this.summary(),
      client.$queryRaw<Array<{ n: number }>>(Prisma.sql`
        SELECT count(*)::int AS n FROM invoice
         WHERE status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID') AND "totalMinor" > 0
      `),
    ]);
    const result: LedgerIntegrityResult = {
      scanned: scanned[0]?.n ?? 0,
      mismatched: counts.total,
      paidButOwing: counts.byKind.PAID_BUT_OWING,
      openButSettled: counts.byKind.OPEN_BUT_SETTLED,
      partialMislabelled: counts.byKind.PARTIAL_MISLABELLED,
      schools: counts.schools,
      failed: 0,
    };
    this.logger.log(
      `ledger integrity (${trigger}): scanned=${result.scanned} mismatched=${result.mismatched} ` +
        `paidButOwing=${result.paidButOwing} openButSettled=${result.openButSettled} ` +
        `partialMislabelled=${result.partialMislabelled} schools=${result.schools}`,
    );
    // An alert that could not be sent is work this run did not do: it counts in
    // `failed`, the field the jobs console reads, rather than only in a log.
    if (result.mismatched > 0) result.failed += await this.alertOwners(result);
    return result;
  }

  /** The manual run, audited to the operator who pressed it. */
  async runManual(p: Principal): Promise<LedgerIntegrityResult> {
    const result = await this.sweep("MANUAL");
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        { actorId: p.userId, action: "fee.ledger.integrity.run", entity: "invoice", entityId: "fleet", schoolId: p.schoolId, metadata: { ...result } },
        tx,
      ),
    );
    return result;
  }

  /**
   * Counts by kind and the schools affected, in ONE pass: a CTE referenced
   * twice is materialised once, so the fleet is judged once, not per figure.
   */
  private async summary(): Promise<{ byKind: Record<LedgerMismatchKind, number>; total: number; schools: number }> {
    const rows = await this.client().$queryRaw<Array<{ kind: LedgerMismatchKind | null; n: number; schools: number }>>(Prisma.sql`
      ${judgedSql()}
      SELECT k.kind, count(m.id)::int AS n, (SELECT count(DISTINCT "schoolId") FROM mismatched)::int AS schools
        FROM (SELECT unnest(ARRAY[${Prisma.join([...LEDGER_MISMATCH_KINDS])}]::text[]) AS kind) k
        LEFT JOIN mismatched m ON m.kind = k.kind
       GROUP BY 1
    `);
    const byKind = Object.fromEntries(
      LEDGER_MISMATCH_KINDS.map((k) => [k, rows.find((r) => r.kind === k)?.n ?? 0]),
    ) as Record<LedgerMismatchKind, number>;
    return { byKind, total: Object.values(byKind).reduce((n, v) => n + v, 0), schools: rows[0]?.schools ?? 0 };
  }

  /**
   * The mismatches, a page at a time, with the TOTAL — worst kind first, then
   * by school and oldest change, so the list is worked in a stable order.
   */
  async list(page = 1): Promise<LedgerMismatchPageDto> {
    const client = this.client();
    const p = Math.max(1, Math.floor(page) || 1);
    const [rows, summary] = await Promise.all([
      client.$queryRaw<
        Array<{
          id: string;
          schoolId: string;
          schoolName: string;
          reference: string;
          currency: string;
          totalMinor: number;
          paid: number;
          status: string;
          derived: string;
          kind: LedgerMismatchKind;
          updatedAt: Date;
        }>
      >(Prisma.sql`
        ${judgedSql()}
        SELECT m.id, m."schoolId", s.name AS "schoolName", m.reference, m.currency, m."totalMinor",
               m.paid::float8 AS paid, m.status, m.derived, m.kind, m."updatedAt"
          FROM mismatched m JOIN school s ON s.id = m."schoolId"
         ORDER BY CASE m.kind WHEN 'PAID_BUT_OWING' THEN 0 WHEN 'OPEN_BUT_SETTLED' THEN 1 ELSE 2 END,
                  s.name, m."updatedAt", m.id
         LIMIT ${LEDGER_MISMATCH_PAGE} OFFSET ${(p - 1) * LEDGER_MISMATCH_PAGE}
      `),
      this.summary(),
    ]);
    return {
      rows: rows.map(
        (r): LedgerMismatchDto => ({
          invoiceId: r.id,
          schoolId: r.schoolId,
          schoolName: r.schoolName,
          reference: r.reference,
          currency: r.currency,
          totalMinor: r.totalMinor,
          netPaidMinor: Math.round(r.paid),
          status: r.status,
          derivedStatus: r.derived,
          kind: r.kind,
          updatedAt: r.updatedAt,
        }),
      ),
      total: summary.total,
      byKind: summary.byKind,
      schools: summary.schools,
    };
  }

  /**
   * Make ONE invoice's label say what its ledger says.
   *
   * SECURITY: a platform write to a school's financial record — so it moves no
   * money and touches no payment, only the status label, and only to the value
   * the one rule derives. Step-up gated at the route, optimistic on the status
   * it read (a payment landing in between wins), audited in BOTH tenants, and
   * the school's finance staff are told by name. A label that already agrees is
   * a 409, not a silent no-op, so a double press is visible.
   */
  async rederive(p: Principal, invoiceId: string): Promise<LedgerRederiveResultDto> {
    const client = this.client();
    const invoice = await client.invoice.findFirst({
      where: { id: invoiceId },
      select: { id: true, schoolId: true, reference: true, status: true, totalMinor: true },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (!["ISSUED", "PARTIALLY_PAID", "PAID"].includes(invoice.status)) {
      throw new ConflictException(`A ${invoice.status} invoice is not a bill whose status follows its payments.`);
    }
    const payments = await client.payment.findMany({
      where: { invoiceId, status: "POSTED" },
      select: { amountMinor: true, kind: true },
    });
    const net = payments.reduce((n, x) => n + (x.kind === "REFUND" ? -x.amountMinor : x.amountMinor), 0);
    const to = invoiceStatusForNet(net, invoice.totalMinor);
    if (to === invoice.status) {
      throw new ConflictException("This invoice's status already agrees with its payments.");
    }
    const claimed = await client.invoice.updateMany({
      where: { id: invoiceId, status: invoice.status },
      data: { status: to },
    });
    if (claimed.count === 0) {
      throw new ConflictException("This invoice changed while it was being checked. Reload and look again.");
    }

    const metadata = { reference: invoice.reference, from: invoice.status, to, netPaidMinor: net, totalMinor: invoice.totalMinor };
    // The operator's own trail, and the SCHOOL's — its finance staff read theirs.
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        { actorId: p.userId, action: "fee.ledger.rederive", entity: "invoice", entityId: invoiceId, schoolId: p.schoolId, metadata: { ...metadata, schoolId: invoice.schoolId } },
        tx,
      ),
    );
    await this.db.runAsTenant({ schoolId: invoice.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        { actorId: p.userId, action: "fee.invoice.status.rederive", entity: "invoice", entityId: invoiceId, schoolId: invoice.schoolId, metadata },
        tx,
      ),
    );
    const notified = await this.tellFinance(invoice.schoolId, invoiceId, invoice.reference, invoice.status, to);
    return { invoiceId, from: invoice.status, to, netPaidMinor: net, totalMinor: invoice.totalMinor, notified };
  }

  /** Finance at the school, by name — counted by who was told, not who was looked up. */
  private async tellFinance(schoolId: string, invoiceId: string, reference: string, from: string, to: string): Promise<number> {
    const client = this.client();
    const staff = await client.userRole.findMany({
      where: { schoolId, role: { name: { in: FINANCE_ROLES } }, user: { status: "ACTIVE" } },
      select: { userId: true },
      distinct: ["userId"],
    });
    let told = 0;
    for (const s of staff) {
      try {
        await this.notifications.enqueue(
          { schoolId, userId: s.userId },
          {
            recipientId: s.userId,
            type: "OPERATOR_ALERT",
            title: `Invoice ${reference}: status corrected to ${to.replace(/_/g, " ").toLowerCase()}`,
            body:
              `Invoice ${reference} was marked ${from.replace(/_/g, " ").toLowerCase()}, which its payments did not support. ` +
              `The platform corrected the status to match the ledger; no payment or amount was changed.`,
            data: { invoiceId, from, to },
          },
        );
        told += 1;
      } catch (e) {
        this.logger.warn(`could not tell finance about ${reference}: ${(e as Error).message}`);
      }
    }
    return told;
  }

  /** Tell every active owner. Returns how many could NOT be told. */
  private async alertOwners(result: LedgerIntegrityResult): Promise<number> {
    let failed = 0;
    const owners = await this.client().user.findMany({
      where: { status: "ACTIVE", roles: { some: { role: { name: "super_admin" } } } },
      select: { id: true, schoolId: true },
    });
    for (const owner of owners) {
      try {
        await this.notifications.enqueue(
          { schoolId: owner.schoolId, userId: owner.id },
          {
            recipientId: owner.id,
            type: "OPERATOR_ALERT",
            title: `${result.mismatched} invoice${result.mismatched === 1 ? "" : "s"} disagree with their payments`,
            body:
              `${result.paidButOwing} marked paid but still owed, ${result.openButSettled} marked open but settled, ` +
              `${result.partialMislabelled} with the wrong part-paid label, across ${result.schools} school(s). ` +
              `Review them under Operator → Ledger integrity.`,
            data: { ...result },
            channels: ["EMAIL"],
          },
        );
      } catch (e) {
        failed += 1;
        this.logger.warn(`ledger integrity owner alert failed: ${(e as Error).message}`);
      }
    }
    return failed;
  }
}
