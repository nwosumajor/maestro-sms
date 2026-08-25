// =============================================================================
// OperatorPaymentsService — the platform's own revenue ledger, cross-tenant
// =============================================================================
// Every school pays the platform for its plan, and until now there was nowhere
// to see those payments as a LIST. The analytics screen showed a lifetime total
// and the ten most recent rows; there was no way to answer "what came in last
// month", "which schools have a payment stuck", or "give me the quarter as a
// CSV for the books".
//
// Cross-tenant by definition, so it runs on the PRIVILEGED client (the app role
// is confined by RLS to the operator's own org, which has no customers in it).
// That makes every read here a deliberate boundary crossing, so every read is
// audited — same posture as the operator's other cross-tenant surfaces.
//
// THE ACCURACY RULE THIS SERVICE ENFORCES: money is NEVER summed across
// currencies. `amountMinor` is a count of minor units in its own currency, so
// kobo + cents is not money in any currency. Totals come back per-currency,
// always, even when only one currency is present — because the shape of the
// answer is what stops the mistake being reintroduced.
// =============================================================================

import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { csvCell } from "../common/csv";
// VALUE import: Prisma.sql only resolves as a value, not a type (CLAUDE.md).
import { Prisma } from "@sms/db";
import type {
  BillingCycle,
  Currency,
  OperatorFeeRevenueDto,
  OperatorPaymentPageDto,
  OperatorPaymentRowDto,
  OperatorRevenueTotalDto,
  Plan,
} from "@sms/types";
import { CURRENCIES, isCurrency } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { toMinor } from "../common/money";

const MAX_PAGE_SIZE = 100;
/** A CSV export is for the books, so it may be large — but not unbounded, or one
 *  click builds the whole lifetime of the platform in memory. */
const MAX_EXPORT_ROWS = 20_000;

export interface PaymentFilters {
  /** Inclusive ISO dates (YYYY-MM-DD) against createdAt. */
  from?: string;
  to?: string;
  status?: string;
  plan?: string;
  currency?: string;
  /** School name search. */
  q?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class OperatorPaymentsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  private client() {
    const client = this.privileged.client;
    if (!client) {
      // Distinguishable from "no payments" — a finance screen that renders an
      // empty table when it could not read is worse than one that errors.
      throw new ServiceUnavailableException(
        "The revenue ledger needs the privileged database configuration (DATABASE_RETENTION_URL / DATABASE_MIGRATE_URL).",
      );
    }
    return client;
  }

  /**
   * A period is a DAY RANGE, and `to` means the whole of that day.
   *
   * Treating `to` as midnight silently drops everything that happened on the
   * last day of the range — which for a month-end finance report is the busiest
   * day of the period.
   */
  private range(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
    const out: { gte?: Date; lte?: Date } = {};
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) out.gte = new Date(`${from}T00:00:00.000Z`);
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) out.lte = new Date(`${to}T23:59:59.999Z`);
    return out.gte || out.lte ? out : undefined;
  }

  private async where(filters: PaymentFilters): Promise<Record<string, unknown>> {
    const where: Record<string, unknown> = {};
    const createdAt = this.range(filters.from, filters.to);
    if (createdAt) where.createdAt = createdAt;
    if (filters.status) where.status = filters.status;
    if (filters.plan) where.plan = filters.plan;
    if (filters.currency) where.currency = filters.currency.toUpperCase();
    if (filters.q?.trim()) {
      const schools = await this.client().school.findMany({
        where: { name: { contains: filters.q.trim(), mode: "insensitive" } },
        select: { id: true },
        take: 500,
      });
      // An empty match must return NOTHING, not everything. Omitting the clause
      // when a search found no school would silently widen the query to the
      // whole platform, which on a revenue screen is the wrong direction.
      where.schoolId = { in: schools.map((s: { id: string }) => s.id) };
    }
    return where;
  }

  /**
   * Totals for the WHOLE filter, split by currency — never just the page.
   *
   * A finance screen whose totals describe only the visible 25 rows is worse
   * than no totals, because it looks authoritative. Computed as one grouped
   * aggregate in Postgres rather than by hydrating rows and adding them up in
   * Node, so it costs the same at 50 payments and at 500,000.
   */
  private async totals(where: Record<string, unknown>): Promise<OperatorRevenueTotalDto[]> {
    // reason: groupBy's generated overload cannot accept a dynamically-built
    // where clause; the arg shape is correct and the RESULT is typed below.
    const groupBy = this.client().platformSubscriptionPayment.groupBy as unknown as (
      args: Record<string, unknown>,
    ) => Promise<Array<{ currency: string; status: string; _sum: { amountMinor: bigint | number | null }; _count: { _all: number } }>>;
    const grouped = await groupBy({
      by: ["currency", "status"],
      where,
      _sum: { amountMinor: true },
      _count: { _all: true },
    });

    const byCurrency = new Map<string, OperatorRevenueTotalDto>();
    for (const row of grouped) {
      const currency = (isCurrency(row.currency) ? row.currency : CURRENCIES.NGN) as Currency;
      const t =
        byCurrency.get(currency) ??
        ({
          currency,
          paidMinor: 0,
          paidCount: 0,
          pendingMinor: 0,
          pendingCount: 0,
          failedCount: 0,
          abandonedCount: 0,
        } satisfies OperatorRevenueTotalDto);
      const sum = toMinor(row._sum.amountMinor);
      const n = row._count._all;
      // Only PAID is revenue. PENDING is money that may yet arrive, and FAILED
      // and ABANDONED are not money at all — conflating them is how a forecast
      // becomes a work of fiction.
      if (row.status === "PAID") {
        t.paidMinor += sum;
        t.paidCount += n;
      } else if (row.status === "PENDING") {
        t.pendingMinor += sum;
        t.pendingCount += n;
      } else if (row.status === "FAILED") {
        t.failedCount += n;
      } else if (row.status === "ABANDONED") {
        t.abandonedCount += n;
      }
      byCurrency.set(currency, t);
    }
    return [...byCurrency.values()].sort((a, b) => b.paidMinor - a.paidMinor);
  }

  private async nameMap(schoolIds: string[]): Promise<Map<string, string>> {
    if (schoolIds.length === 0) return new Map();
    const schools = await this.client().school.findMany({
      where: { id: { in: schoolIds } },
      select: { id: true, name: true },
    });
    return new Map(schools.map((s: { id: string; name: string }) => [s.id, s.name]));
  }

  /** One page of payments plus totals for the whole filter. Audited. */
  async list(p: Principal, filters: PaymentFilters): Promise<OperatorPaymentPageDto> {
    const where = await this.where(filters);
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filters.pageSize ?? 25));

    const [rows, total, totals, feeRevenue] = await Promise.all([
      this.client().platformSubscriptionPayment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.client().platformSubscriptionPayment.count({ where }),
      this.totals(where),
      this.feeRevenue(filters),
    ]);

    const names = await this.nameMap([...new Set(rows.map((r: { schoolId: string }) => r.schoolId))]);
    await this.record(p, "platform.revenue.read", { ...filters, returned: rows.length });

    return {
      rows: rows.map((r: Record<string, unknown>) => this.toRow(r, names)),
      page,
      pageSize,
      total,
      totals,
      feeRevenue,
    };
  }

  /**
   * THE OTHER HALF OF THE PLATFORM'S INCOME.
   *
   * Subscriptions are only one revenue line. The take-rate on fee collection —
   * `platform_fee_config`, flat + basis points, capped, borne by the parent —
   * is computed at checkout and stamped onto every settled online payment as
   * `payment.platformFeeMinor`. That column was written by the settlement path
   * and READ BY NOTHING: no DTO, no endpoint and no screen in the product
   * mentioned it, so the owner who sets the rate had no way to see what it
   * earned. An instance of "written, never read" on the revenue lever the fee
   * rail exists for.
   *
   * PER CURRENCY, joining through the invoice, because a payment carries no
   * currency of its own — assuming naira here would report a Ghanaian school's
   * cedi cut as naira and add it to the naira line.
   *
   * Only the DATE RANGE of the filter applies. The other filters (plan, status,
   * school search) describe SUBSCRIPTION payments and mean nothing here, and
   * silently reinterpreting them would make this figure move for reasons its
   * label does not explain.
   */
  private async feeRevenue(filters: PaymentFilters): Promise<OperatorFeeRevenueDto[]> {
    const range = this.range(filters.from, filters.to);
    const rows = await this.client().$queryRaw<
      Array<{ currency: string; feeMinor: number; payments: number; collectedMinor: number }>
    >(Prisma.sql`
      SELECT i.currency,
             COALESCE(SUM(p."platformFeeMinor"), 0)::float8 AS "feeMinor",
             count(*)::int                                  AS payments,
             COALESCE(SUM(p."amountMinor"), 0)::float8      AS "collectedMinor"
        FROM "payment" p JOIN "invoice" i ON i.id = p."invoiceId"
       WHERE p.status = 'POSTED' AND p."platformFeeMinor" > 0
         ${range?.gte ? Prisma.sql`AND p."createdAt" >= ${range.gte}` : Prisma.sql``}
         ${range?.lte ? Prisma.sql`AND p."createdAt" <= ${range.lte}` : Prisma.sql``}
       GROUP BY i.currency
    `);
    return rows
      .map((r) => ({
        currency: r.currency,
        feeMinor: Math.round(Number(r.feeMinor)),
        payments: Number(r.payments),
        collectedMinor: Math.round(Number(r.collectedMinor)),
      }))
      .sort((a, b) => b.feeMinor - a.feeMinor);
  }

  /** The same filter as a CSV for the books. Audited, formula-guarded. */
  async csv(p: Principal, filters: PaymentFilters): Promise<{ csv: string; filename: string }> {
    const where = await this.where(filters);
    const rows = await this.client().platformSubscriptionPayment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: MAX_EXPORT_ROWS,
    });
    const names = await this.nameMap([...new Set(rows.map((r: { schoolId: string }) => r.schoolId))]);
    await this.record(p, "platform.revenue.export", { ...filters, returned: rows.length });

    const header = [
      "Date", "School", "Reference", "Plan", "Cycle", "Kind",
      "Seats", "Amount (minor)", "Currency", "Status", "Period start", "Period end", "Paid at",
    ];
    const lines = [header.map((h) => csvCell(h)).join(",")];
    for (const raw of rows) {
      const r = this.toRow(raw as Record<string, unknown>, names);
      lines.push(
        [
          r.createdAt.toISOString().slice(0, 10),
          r.schoolName,
          r.reference,
          r.plan,
          r.billingCycle,
          r.kind,
          String(r.seats),
          // The MINOR-unit integer, deliberately. A spreadsheet that divides by
          // 100 is wrong for a zero-decimal currency, so the export ships the
          // exact stored figure next to its currency and lets the reader decide.
          String(r.amountMinor),
          r.currency,
          r.status,
          r.periodStart?.toISOString().slice(0, 10) ?? "",
          r.periodEnd?.toISOString().slice(0, 10) ?? "",
          r.paidAt?.toISOString() ?? "",
        ]
          .map((c) => csvCell(c))
          .join(","),
      );
    }
    const stamp = `${filters.from ?? "all"}_${filters.to ?? "all"}`;
    return { csv: lines.join("\n"), filename: `platform-revenue-${stamp}.csv` };
  }

  private toRow(r: Record<string, unknown>, names: Map<string, string>): OperatorPaymentRowDto {
    const schoolId = r.schoolId as string;
    return {
      id: r.id as string,
      schoolId,
      schoolName: names.get(schoolId) ?? "—",
      reference: r.reference as string,
      plan: r.plan as Plan,
      billingCycle: r.billingCycle as BillingCycle,
      kind: (r.kind as string) ?? "RENEWAL",
      seats: (r.seats as number) ?? 0,
      amountMinor: toMinor(r.amountMinor as bigint | number | null),
      currency: (isCurrency(r.currency as string) ? r.currency : CURRENCIES.NGN) as Currency,
      status: r.status as string,
      periodStart: (r.periodStart as Date | null) ?? null,
      periodEnd: (r.periodEnd as Date | null) ?? null,
      paidAt: (r.paidAt as Date | null) ?? null,
      createdAt: r.createdAt as Date,
    };
  }

  /** Quote + neutralise spreadsheet formula injection (OWASP CSV injection). */

  /** Every cross-tenant revenue read is audited in the operator's own tenant. */
  private async record(p: Principal, action: string, metadata: Record<string, unknown>): Promise<void> {
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        { actorId: p.userId, action, entity: "platform_subscription_payment", entityId: p.schoolId, schoolId: p.schoolId, metadata },
        tx,
      ),
    );
  }
}
