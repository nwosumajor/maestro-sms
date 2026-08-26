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
  OperatorCreditPurchaseDto,
  OperatorFeeRevenueDto,
  OperatorPaymentPageDto,
  OperatorSeatArrearsDto,
  OperatorPaymentRowDto,
  OperatorRevenueTotalDto,
  Plan,
} from "@sms/types";
import { CURRENCIES, COUNTRIES, PLATFORM_HOME_CURRENCY, describePlatformCharge, isCurrency } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { toMinor } from "../common/money";
import { dateWindow } from "../common/status-filter";

/** What the ledger needs to know about a school, beyond its name. */
interface SchoolFacts {
  name: string;
  country: string | null;
  currency: string;
  timezone: string | null;
}

const MAX_PAGE_SIZE = 100;
/** A CSV export is for the books, so it may be large — but not unbounded, or one
 *  click builds the whole lifetime of the platform in memory. */
const MAX_EXPORT_ROWS = 20_000;
/** Credit purchases shown beside the subscription page. The totals cover the
 *  whole range, so this is a preview and never the whole answer. */
const CREDIT_PURCHASE_PREVIEW = 50;

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
    // // GOTCHA: this used to test the date-only shape itself and SILENTLY DROP
    // anything else — so `?from=2026-08-01T00:00:00Z`, a perfectly good date in
    // the other standard format, returned the ALL-TIME total under an August
    // caption. Measured live: NGN 25,700,236.64 across 17 payments for a window
    // that held a fraction of it. The header above this class says these
    // filters live in the URL precisely so a finance query can be bookmarked
    // and shared with an accountant, which makes a hand-held URL a first-class
    // input rather than an edge case.
    const { from: gte, to: lte } = dateWindow(from, to);
    return gte || lte ? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } : undefined;
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

  /**
   * Name AND REGION, for the page's schools only.
   *
   * A ledger that says which school paid and not WHERE it is cannot answer the
   * first question a finance desk asks of a cross-border book. The region is
   * also not derivable from the charge: `currency` on the row is what the
   * CHARGE was raised in, and a Ghanaian school can be billed in USD.
   *
   * One query for the page, sized by pageSize and never by the fleet — the same
   * discipline the operator tenant list already applies.
   */
  private async schoolMap(schoolIds: string[]): Promise<Map<string, SchoolFacts>> {
    if (schoolIds.length === 0) return new Map();
    const schools = (await this.client().school.findMany({
      where: { id: { in: schoolIds } },
      select: { id: true, name: true, country: true, currency: true, timezone: true },
    })) as Array<{ id: string; name: string; country: string | null; currency: string | null; timezone: string | null }>;
    return new Map(
      schools.map((s) => [
        s.id,
        {
          name: s.name,
          // The country's NAME, not its ISO code: a ledger read by a finance
          // desk should not need the catalogue open beside it. An unrecognised
          // code falls back to itself rather than to null — "ZZ" is more use
          // than a blank.
          country: s.country ? (COUNTRIES[s.country]?.name ?? s.country) : null,
          // A school with no region set is on the platform's home country, and
          // that is what every other resolver in the product assumes too.
          currency: s.currency ?? PLATFORM_HOME_CURRENCY,
          timezone: s.timezone ?? null,
        },
      ]),
    );
  }

  /** Who at the school started these checkouts. One query for the page. */
  private async initiatorMap(userIds: string[]): Promise<Map<string, { name: string; email: string }>> {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (ids.length === 0) return new Map();
    const users = (await this.client().user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true },
    })) as Array<{ id: string; name: string; email: string }>;
    return new Map(users.map((u) => [u.id, { name: u.name, email: u.email }]));
  }

  /** One page of payments plus totals for the whole filter. Audited. */
  async list(p: Principal, filters: PaymentFilters): Promise<OperatorPaymentPageDto> {
    const where = await this.where(filters);
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filters.pageSize ?? 25));

    const [rows, total, totals, feeRevenue, credits, seatArrears] = await Promise.all([
      this.client().platformSubscriptionPayment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.client().platformSubscriptionPayment.count({ where }),
      this.totals(where),
      this.feeRevenue(filters),
      this.creditPurchases(filters),
      this.seatArrears(),
    ]);

    const [names, initiators] = await Promise.all([
      this.schoolMap([...new Set(rows.map((r: { schoolId: string }) => r.schoolId))]),
      this.initiatorMap(rows.map((r: { initiatedById?: string }) => r.initiatedById ?? "")),
    ]);
    await this.record(p, "platform.revenue.read", { ...filters, returned: rows.length });

    return {
      rows: rows.map((r: Record<string, unknown>) => this.toRow(r, names, initiators)),
      page,
      pageSize,
      total,
      totals,
      feeRevenue,
      creditPurchases: credits.rows,
      creditRevenue: credits.totals,
      seatArrears,
    };
  }

  /**
   * WHAT THE PLATFORM IS OWED FOR SEATS IT HAS ALREADY CARRIED.
   *
   * A school buys a seat count and its roll grows mid-period. The nightly sweep
   * meters the difference in seat-days onto `seatArrearsMinor`, and it is
   * collected when the school tops up or, automatically, on its next renewal.
   * Until then it is earned, unbilled revenue — and it appeared on no revenue
   * screen. The attention queue flagged WHICH schools had some without ever
   * saying how much, and nothing added it up, so "what are we owed?" had no
   * answer anywhere in the product.
   *
   * NOT filtered by the date range. This is a POSITION — what is owed right
   * now — and narrowing it to a reporting window would answer a question nobody
   * asked with a number that looks like the one they did.
   *
   * `stranded` is the part no automatic path will ever collect. Every
   * collection point refuses cross-currency arithmetic, which is right — there
   * is no FX rate here and inventing one to move a debt would be worse than the
   * debt. But a school that moved from a naira tier to USD-priced ENTERPRISE
   * leaves its naira arrears behind, skipped by the top-up and by every renewal,
   * silently and for ever. Naming it is the fix; converting it is not.
   */
  private async seatArrears(): Promise<OperatorSeatArrearsDto[]> {
    const rows = await this.client().$queryRaw<
      Array<{ currency: string; amountMinor: number; schools: number; strandedMinor: number; strandedSchools: number }>
    >(Prisma.sql`
      SELECT
        COALESCE(s.currency, ${PLATFORM_HOME_CURRENCY})                                   AS currency,
        COALESCE(SUM(s."seatArrearsMinor"), 0)::float8                                    AS "amountMinor",
        count(*)::int                                                                     AS schools,
        COALESCE(SUM(s."seatArrearsMinor") FILTER (WHERE p.currency IS NOT NULL
                 AND p.currency <> COALESCE(s.currency, ${PLATFORM_HOME_CURRENCY})), 0)::float8 AS "strandedMinor",
        count(*) FILTER (WHERE p.currency IS NOT NULL
                 AND p.currency <> COALESCE(s.currency, ${PLATFORM_HOME_CURRENCY}))::int  AS "strandedSchools"
      FROM "school_subscription" s
      -- The currency of the school's LAST settled charge: what its next one will
      -- be raised in, and therefore what the arrears must match to be collected.
      LEFT JOIN LATERAL (
        SELECT currency FROM "platform_subscription_payment" pp
        WHERE pp."schoolId" = s."schoolId" AND pp.status = 'PAID'
        ORDER BY pp."paidAt" DESC NULLS LAST LIMIT 1
      ) p ON true
      WHERE s."seatArrearsMinor" > 0
      GROUP BY 1
    `);
    return rows
      .map((r) => ({
        currency: r.currency,
        amountMinor: Math.round(Number(r.amountMinor)),
        schools: Number(r.schools),
        strandedMinor: Math.round(Number(r.strandedMinor)),
        strandedSchools: Number(r.strandedSchools),
      }))
      .sort((a, b) => b.amountMinor - a.amountMinor);
  }

  /**
   * THE THIRD THING A SCHOOL PAYS US FOR.
   *
   * Subscriptions are one line and the fee take-rate is another; message-credit
   * bundles are a third, and they appeared on NO screen in this product. They
   * do not touch `platform_subscription_payment` — settlement writes a tenant
   * `message_credit_entry` — so the revenue ledger could not see them, and
   * until `20270106000000` the AMOUNT was never persisted at all, only the
   * credits granted. A ledger of what schools paid that omits a product we sell
   * is not a ledger of what schools paid.
   *
   * A SEPARATE LIST, not rows in the subscription table. A bundle has no plan,
   * no seats and no period; giving it a row with those columns empty would
   * invite a reader to think the data was missing rather than inapplicable.
   *
   * Only the DATE RANGE applies, for the reason `feeRevenue` gives: plan and
   * subscription status describe subscriptions and mean nothing here.
   */
  private async creditPurchases(filters: PaymentFilters): Promise<{
    rows: OperatorCreditPurchaseDto[];
    totals: Array<{ currency: string; amountMinor: number; purchases: number; credits: number }>;
  }> {
    const range = this.range(filters.from, filters.to);
    const where: Record<string, unknown> = { reason: "PURCHASE" };
    if (range) where.createdAt = range;
    const [rows, grouped] = await Promise.all([
      this.client().messageCreditEntry.findMany({
        where,
        orderBy: { createdAt: "desc" },
        // Bounded like every other list here. The totals beside it cover the
        // whole range, so the cap never becomes a wall in front of the money.
        take: CREDIT_PURCHASE_PREVIEW,
      }) as Promise<Array<Record<string, unknown>>>,
      this.client().messageCreditEntry.groupBy({
        by: ["currency"],
        where,
        _sum: { amountMinor: true, deltaCredits: true },
        _count: { _all: true },
      }) as unknown as Promise<
        Array<{ currency: string | null; _sum: { amountMinor: number | null; deltaCredits: number | null }; _count: { _all: number } }>
      >,
    ]);
    const names = await this.schoolMap([...new Set(rows.map((r) => r.schoolId as string))]);
    return {
      rows: rows.map((r) => {
        const school = names.get(r.schoolId as string);
        return {
          id: r.id as string,
          schoolId: r.schoolId as string,
          schoolName: school?.name ?? "—",
          region: { country: school?.country ?? null, currency: school?.currency ?? PLATFORM_HOME_CURRENCY },
          bundleId: (r.bundleId as string | null) ?? null,
          credits: (r.deltaCredits as number) ?? 0,
          // THROUGH `toMinor`, even though this column is an Int rather than the
          // BigInt on the subscription table. `money-boundary` refuses
          // `.amountMinor as number` anywhere in the API and is right to: it
          // cannot tell which model a field name belongs to, and the day one of
          // these widens the cast would compile and throw at serialisation.
          // NULL is preserved — a purchase settled before the amount was
          // recorded is unknown, which is not zero.
          amountMinor: r.amountMinor == null ? null : toMinor(r.amountMinor as bigint | number),
          currency: (r.currency as string | null) ?? null,
          reference: (r.reference as string | null) ?? null,
          paidAt: r.createdAt as Date,
        };
      }),
      totals: grouped
        // A row with no currency is a purchase settled before the amount was
        // recorded. It is counted nowhere rather than being folded into a
        // currency it never said it was — the same rule the credit ledger and
        // the fee report follow.
        .filter((g) => g.currency)
        .map((g) => ({
          currency: g.currency as string,
          amountMinor: Number(g._sum.amountMinor ?? 0),
          purchases: g._count._all,
          credits: Number(g._sum.deltaCredits ?? 0),
        }))
        .sort((a, b) => b.amountMinor - a.amountMinor),
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
    const [names, initiators] = await Promise.all([
      this.schoolMap([...new Set(rows.map((r: { schoolId: string }) => r.schoolId))]),
      this.initiatorMap(rows.map((r: { initiatedById?: string }) => r.initiatedById ?? "")),
    ]);
    await this.record(p, "platform.revenue.export", { ...filters, returned: rows.length });

    // THE EXPORT CARRIES WHAT THE SCREEN CARRIES. An export that is a subset of
    // the page is the one a reconciliation actually runs against, so a column
    // missing here is a question nobody can answer from the books.
    const header = [
      "Date paid", "Date started", "School", "Country", "School currency", "Purpose",
      "Reference", "Plan", "Cycle", "Periods", "Kind", "Add-on module", "Seats",
      "Amount (minor)", "Currency", "Arrears (minor)", "Promo", "Status",
      "Period start", "Period end", "Tenor (days)", "Initiated by",
    ];
    const lines = [header.map((h) => csvCell(h)).join(",")];
    for (const raw of rows) {
      const r = this.toRow(raw as Record<string, unknown>, names, initiators);
      lines.push(
        [
          // THE DATE THE MONEY ARRIVED comes first, because that is the date a
          // book is kept on. The checkout date is beside it and is not the same
          // thing — a charge started on the 31st and settled on the 1st belongs
          // to the new month.
          r.paidAt?.toISOString().slice(0, 10) ?? "",
          r.createdAt.toISOString().slice(0, 10),
          r.schoolName,
          r.region.country ?? "",
          r.region.currency,
          r.purpose,
          r.reference,
          r.plan,
          r.billingCycle,
          String(r.billingPeriods),
          r.kind,
          r.addonModule ?? "",
          String(r.seats),
          // The MINOR-unit integer, deliberately. A spreadsheet that divides by
          // 100 is wrong for a zero-decimal currency, so the export ships the
          // exact stored figure next to its currency and lets the reader decide.
          String(r.amountMinor),
          r.currency,
          String(r.arrearsMinor),
          r.promoCode ?? "",
          r.status,
          r.periodStart?.toISOString().slice(0, 10) ?? "",
          r.periodEnd?.toISOString().slice(0, 10) ?? "",
          r.tenorDays == null ? "" : String(r.tenorDays),
          r.initiatedBy ? `${r.initiatedBy.name} <${r.initiatedBy.email}>` : "",
        ]
          .map((c) => csvCell(c))
          .join(","),
      );
    }
    const stamp = `${filters.from ?? "all"}_${filters.to ?? "all"}`;
    return { csv: lines.join("\n"), filename: `platform-revenue-${stamp}.csv` };
  }

  private toRow(
    r: Record<string, unknown>,
    names: Map<string, SchoolFacts>,
    initiators: Map<string, { name: string; email: string }>,
  ): OperatorPaymentRowDto {
    const schoolId = r.schoolId as string;
    const school = names.get(schoolId);
    const periodStart = (r.periodStart as Date | null) ?? null;
    const periodEnd = (r.periodEnd as Date | null) ?? null;
    const kind = (r.kind as string) ?? "RENEWAL";
    const plan = r.plan as Plan;
    const billingCycle = r.billingCycle as BillingCycle;
    const billingPeriods = (r.billingPeriods as number) ?? 1;
    const addonModule = (r.addonModule as string | null) ?? null;
    const promoCode = (r.promoCode as string | null) ?? null;
    const seats = (r.seats as number) ?? 0;
    return {
      id: r.id as string,
      schoolId,
      schoolName: school?.name ?? "—",
      reference: r.reference as string,
      plan,
      billingCycle,
      kind,
      seats,
      amountMinor: toMinor(r.amountMinor as bigint | number | null),
      currency: (isCurrency(r.currency as string) ? r.currency : CURRENCIES.NGN) as Currency,
      status: r.status as string,
      periodStart,
      periodEnd,
      paidAt: (r.paidAt as Date | null) ?? null,
      createdAt: r.createdAt as Date,
      purpose: describePlatformCharge({ kind, plan, billingCycle, billingPeriods, addonModule, seats, promoCode }),
      region: {
        country: school?.country ?? null,
        currency: school?.currency ?? PLATFORM_HOME_CURRENCY,
        timezone: school?.timezone ?? null,
      },
      // Only when the charge actually MOVED the period. A true-up and an add-on
      // buy no time — reporting the subscription's existing tenor against them
      // would double-count the same window across two rows of the book.
      tenorDays:
        periodStart && periodEnd
          ? Math.max(0, Math.round((periodEnd.getTime() - periodStart.getTime()) / 86_400_000))
          : null,
      billingPeriods,
      addonModule,
      promoCode,
      arrearsMinor: toMinor(r.arrearsMinor as bigint | number | null),
      initiatedBy: initiators.get((r.initiatedById as string) ?? "") ?? null,
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
