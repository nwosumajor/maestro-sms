// =============================================================================
// FeesService — fee catalog, invoices, payments, balances
// =============================================================================
// Finance staff (accountant / school_admin / principal) manage the catalog,
// issue invoices, and record payments; board has read oversight. Parents read
// their CHILDREN's invoices, students their OWN — relationship-scoped here on top
// of RLS. Money is INTEGER minor units throughout (no floats). Every financial
// mutation is audit-logged. Producers notify guardians on issue (amount due) and
// on full payment (receipt). Not-visible -> 404 (never 403).
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
// VALUE import: Prisma.sql/join only resolve as values, not types (CLAUDE.md).
import { Prisma } from "@sms/db";
import {
  effectivePaymentApprovalThresholdMinor,
  PAYMENT_APPROVAL_WINDOW_HOURS,
  PLATFORM_HOME_CURRENCY,
  paymentNeedsApproval,
  type FeeCurrencyReportDto,
  type FeeReportDto,
  type InvoiceSummaryDto,
  type InvoiceStatusValue,
  type PaymentMethodValue, formatMoney, FEE_SOURCES, FEE_SOURCE_LABELS } from "@sms/types";
import type { FeeSourceReportDto, FeeSource } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { NotificationService } from "../notifications/notification.service";
import { PaystackService } from "../payments/paystack.service";
import { SchoolRegionService } from "../foundation/school-region.service";
import { dateWindow } from "../common/status-filter";

/** Roles that see ALL billing rows in the tenant. */
/** Invoices per page. One issue run for a class is ~30-40 rows, so a page shows a
 *  class's worth at a time. */
const INVOICE_PAGE_SIZE = 50;
/** Ceiling a caller can request per page. */
const INVOICE_PAGE_MAX = 200;

// junior_admin does "fee RECORDING" for the whole school (CLAUDE.md) and holds
// fee.read + fee.manage. Without it here both were dead: /invoices returned zero
// rows, assertCanAccessStudent 404'd every invoice, and /fees/reports answered
// scope:"none" (which bounces the page back to /fees). A tier that may record a
// payment could not open a single invoice to record one against.
//
// SECURITY: this set is a ROW SCOPE, never an authority. Approving a payment or
// a refund needs fee.approve, which junior_admin deliberately does NOT hold — so
// the maker-checker split survives untouched: junior_admin records, and a
// different person with fee.approve releases anything over the threshold.
const BILLING_WIDE_ROLES = new Set([
  "accountant",
  "school_admin",
  "principal",
  "board",
  "junior_admin",
]);

export interface FeeItemInput {
  name: string;
  description?: string | null;
  amountMinor: number;
  currency?: string;
  active?: boolean;
}
export interface InvoiceLineInput {
  description: string;
  amountMinor: number;
  quantity?: number;
  feeItemId?: string | null;
}
export interface CreateInvoiceInput {
  studentId: string;
  dueDate: string; // YYYY-MM-DD
  reference?: string;
  notes?: string | null;
  currency?: string;
  lines: InvoiceLineInput[];
}
export interface PaymentInput {
  amountMinor: number;
  method: PaymentMethodValue;
  kind?: "PAYMENT" | "REFUND";
  reference?: string | null;
  note?: string | null;
  paidAt?: string;
}

@Injectable()
export class FeesService {
  private readonly logger = new Logger("Fees");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly paystack: PaystackService,
    private readonly region: SchoolRegionService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isBillingWide(p: Principal): boolean {
    return p.roles.some((r) => BILLING_WIDE_ROLES.has(r));
  }

  // --- fee catalog (manage roles) -------------------------------------------
  async listFeeItems(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.feeItem.findMany({ orderBy: { name: "asc" } }),
    );
  }

  async createFeeItem(p: Principal, input: FeeItemInput) {
    this.assertNonNegative(input.amountMinor, "amountMinor");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const item = await tx.feeItem.create({
        data: {
          schoolId: p.schoolId,
          name: input.name,
          description: input.description ?? null,
          amountMinor: input.amountMinor,
          currency: input.currency ?? "NGN",
          active: input.active ?? true,
        },
      });
      await this.log(tx, p, "fee.item.create", "fee_item", item.id);
      return item;
    });
  }

  async updateFeeItem(p: Principal, id: string, input: Partial<FeeItemInput>) {
    if (input.amountMinor !== undefined) this.assertNonNegative(input.amountMinor, "amountMinor");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.feeItem.findFirst({ where: { id }, select: { id: true } });
      if (!existing) throw new NotFoundException("Fee item not found");
      const item = await tx.feeItem.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description ?? undefined,
          amountMinor: input.amountMinor,
          currency: input.currency,
          active: input.active,
        },
      });
      await this.log(tx, p, "fee.item.update", "fee_item", id);
      return item;
    });
  }

  // --- invoices --------------------------------------------------------------
  async createInvoice(p: Principal, input: CreateInvoiceInput) {
    if (!input.lines || input.lines.length === 0) {
      throw new BadRequestException("An invoice needs at least one line item");
    }
    for (const l of input.lines) {
      this.assertNonNegative(l.amountMinor, "amountMinor");
      if ((l.quantity ?? 1) < 1) throw new BadRequestException("quantity must be >= 1");
    }
    const total = input.lines.reduce((n, l) => n + l.amountMinor * (l.quantity ?? 1), 0);

    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const student = await tx.user.findFirst({
        where: { id: input.studentId },
        select: { id: true },
      });
      if (!student) throw new NotFoundException("Student not found");

      const invoice = await tx.invoice.create({
        data: {
          schoolId: p.schoolId,
          studentId: input.studentId,
          reference: input.reference?.trim() || this.genReference(),
          status: "DRAFT",
          currency: input.currency ?? "NGN",
          totalMinor: total,
          dueDate: new Date(input.dueDate),
          notes: input.notes ?? null,
          createdById: p.userId,
        },
      });
      // One bulk insert for the invoice lines (not one INSERT per line).
      await tx.invoiceLineItem.createMany({
        data: input.lines.map((l) => ({
          schoolId: p.schoolId,
          invoiceId: invoice.id,
          feeItemId: l.feeItemId ?? null,
          description: l.description,
          amountMinor: l.amountMinor,
          quantity: l.quantity ?? 1,
          // The school's own catalogue. Hostel, transport and library raise
          // their charges through their own services and stamp their own.
          source: FEE_SOURCES.TUITION,
        })),
      });
      await this.log(tx, p, "fee.invoice.create", "invoice", invoice.id, {
        studentId: input.studentId,
        totalMinor: total,
      });
      return this.loadInvoice(tx, invoice.id);
    });
  }

  /** Send payment reminders to guardians of students with OUTSTANDING invoices
   *  (ISSUED / PARTIALLY_PAID). Optionally only overdue ones (dueDate < today).
   *  Reuses the guardian-notify path (in-app + email/SMS via the channel provider).
   *  Staff-triggered (fee.manage). Returns how many reminders were sent. */
  async sendFeeReminders(p: Principal, opts: { overdueOnly?: boolean } = {}): Promise<{ reminded: number; invoices: number }> {
    const today = new Date();
    const targets = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where: Record<string, unknown> = { status: { in: ["ISSUED", "PARTIALLY_PAID"] } };
      if (opts.overdueOnly) where.dueDate = { lt: today };
      const invoices = await tx.invoice.findMany({
        where,
        // `currency` is selected because the reminder QUOTES the balance. An
        // invoice carries its own currency per row, so an NGN invoice prints in
        // naira whatever the school has since moved to.
        select: { id: true, studentId: true, reference: true, totalMinor: true, dueDate: true, currency: true },
        take: 2000,
      });
      // Sum paid per invoice to compute the outstanding balance.
      const ids = invoices.map((i: { id: string }) => i.id);
      const payments = ids.length
        ? await tx.payment.findMany({ where: { invoiceId: { in: ids }, status: "POSTED" }, select: { invoiceId: true, amountMinor: true } })
        : [];
      const paidByInvoice = new Map<string, number>();
      for (const pay of payments as Array<{ invoiceId: string; amountMinor: number }>) {
        paidByInvoice.set(pay.invoiceId, (paidByInvoice.get(pay.invoiceId) ?? 0) + pay.amountMinor);
      }
      return invoices
        .map((inv: { id: string; studentId: string; reference: string; totalMinor: number; dueDate: Date; currency: string }) => ({
          ...inv,
          outstanding: inv.totalMinor - (paidByInvoice.get(inv.id) ?? 0),
        }))
        .filter((inv: { outstanding: number }) => inv.outstanding > 0);
    });

    let reminded = 0;
    for (const inv of targets) {
      const overdue = inv.dueDate < today;
      await this.notifyGuardians(p, inv.studentId, {
        type: "FEE_REMINDER",
        title: overdue ? "Overdue fee reminder" : "Fee payment reminder",
        // formatMoney, never minor/100: this service already had the helper and
        // this one call site did not use it. A bare `/100` with no symbol told a
        // Ghanaian parent they owed "5000.00" of nothing, and a CFA-franc parent
        // a HUNDREDTH of what they owe — in a message asking them to pay it.
        body: `Invoice ${inv.reference} has an outstanding balance of ${this.money(inv.outstanding, inv.currency)}${overdue ? ` (due ${inv.dueDate.toISOString().slice(0, 10)})` : ""}.`,
        data: { invoiceId: inv.id, outstandingMinor: inv.outstanding },
      });
      reminded++;
    }
    return { reminded, invoices: targets.length };
  }

  /** DRAFT -> ISSUED, then notify the student's guardians of the amount due. */
  async issueInvoice(p: Principal, id: string) {
    const invoice = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id } });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status !== "DRAFT") {
        throw new BadRequestException(`Cannot issue an invoice that is ${inv.status}`);
      }
      const updated = await tx.invoice.update({
        where: { id },
        data: { status: "ISSUED", issuedAt: new Date() },
      });
      await this.log(tx, p, "fee.invoice.issue", "invoice", id);
      return updated;
    });

    await this.notifyGuardians(p, invoice.studentId, {
      type: "INVOICE_ISSUED",
      title: "New invoice",
      body: `Invoice ${invoice.reference} for ${this.money(invoice.totalMinor, invoice.currency)} is due on ${this.dateOnly(invoice.dueDate)}.`,
      data: { invoiceId: invoice.id, reference: invoice.reference },
    });
    return invoice;
  }

  /**
   * Issue MANY drafts in one action.
   *
   * A fee run is a batch — hostel rent for every boarder, transport fares for a
   * route, a term's tuition — and each one lands as a DRAFT invoice, because a
   * draft is where a bursar assembles a bill. There was no way to finish that:
   * `POST /invoices/:id/issue` is the only issue path and the UI offers it on
   * the single-invoice page, so making a 200-boarder rent run real meant
   * opening 200 invoices. What happens instead is that nobody does it, and the
   * charges stay DRAFT — invisible to families (the list deliberately hides
   * drafts), absent from receivables and the ageing report, and uncollectable
   * online.
   *
   * Explicit ids, never "issue everything": a draft is by definition a bill
   * somebody is still assembling, and a filter-driven sweep would issue the
   * half-finished one sitting next to the batch.
   *
   * PARTIAL SUCCESS IS THE HONEST OUTCOME. An id that is not DRAFT any more —
   * already issued, cancelled, issued by a colleague a second ago — is reported
   * as skipped rather than failing the batch, because the alternative is a
   * bursar pressing the button again and wondering which half took.
   */
  async issueInvoices(p: Principal, ids: string[]): Promise<{ issued: string[]; skipped: Array<{ id: string; reason: string }> }> {
    const issued: Array<{ id: string; studentId: string; reference: string; totalMinor: number; currency: string; dueDate: Date }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    await this.db.runAsTenant(this.ctx(p), async (tx) => {
      for (const id of [...new Set(ids)]) {
        // Claimed, not read-then-written: two bursars pressing this on the same
        // batch would otherwise both "issue" it and both notify the family.
        const claimed = await tx.invoice.updateMany({
          where: { id, status: "DRAFT" },
          data: { status: "ISSUED", issuedAt: new Date() },
        });
        if (claimed.count === 0) {
          const inv = await tx.invoice.findFirst({ where: { id }, select: { status: true } });
          skipped.push({ id, reason: inv ? `already ${inv.status}` : "not found" });
          continue;
        }
        const inv = await tx.invoice.findFirst({
          where: { id },
          select: { id: true, studentId: true, reference: true, totalMinor: true, currency: true, dueDate: true },
        });
        if (inv) issued.push(inv);
        await this.log(tx, p, "fee.invoice.issue", "invoice", id, { bulk: true });
      }
    });
    // Told AFTER the transaction, one family at a time: a notification failure
    // must not roll back invoices that are now real bills.
    for (const inv of issued) {
      await this.notifyGuardians(p, inv.studentId, {
        type: "INVOICE_ISSUED",
        title: "New invoice",
        body: `Invoice ${inv.reference} for ${this.money(inv.totalMinor, inv.currency)} is due on ${this.dateOnly(inv.dueDate)}.`,
        data: { invoiceId: inv.id, reference: inv.reference },
      });
    }
    return { issued: issued.map((i) => i.id), skipped };
  }

  async cancelInvoice(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id } });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status === "PAID") throw new BadRequestException("Cannot cancel a paid invoice");
      const updated = await tx.invoice.update({ where: { id }, data: { status: "CANCELLED" } });
      await this.log(tx, p, "fee.invoice.cancel", "invoice", id);
      return updated;
    });
  }

  /**
   * Receivables aging + collection summary (billing-wide staff/board only).
   *
   * scale: computed ENTIRELY in Postgres — the same treatment AnalyticsService
   * already gives its fee stats, and for the same reason. This used to load
   * EVERY non-DRAFT invoice the school has ever issued, each with its POSTED
   * payments, into Node and add them up in a JS loop. Nothing bounded it: not a
   * date window, not a cap, and financial records are never deleted, so the cost
   * grew with the school's whole lifetime on a page finance staff open daily.
   * Measured at 5,401 invoices / 4,502 payments it took 308ms against 1.3ms for
   * the SQL — the time was Prisma hydrating ten thousand objects, not the query
   * — which puts a ten-year-old school of the same size around three seconds.
   *
   * The money SUMs are cast ::float8, NOT ::int/::bigint: a lifetime kobo total
   * overflows int4, and Prisma maps int8 to a JS BigInt that the JSON layer
   * cannot serialize. float8 is exact for integers to 2^53 — identical
   * semantics to the JS reduce it replaces.
   *
   * `today` is still computed in JS and passed in, deliberately: CURRENT_DATE
   * would read the DB session's timezone and silently move every bucket
   * boundary by a day. Same expression as before, so the buckets do not shift.
   */
  /**
   * What each part of the school brought in, separated.
   *
   * Hostel rent, transport fares, library fines and tuition all land on the
   * same line-item table so a family gets ONE bill — which left "what did
   * boarding bring in this term?" with no answer. Each line now carries the
   * source the raising module stamped on it.
   *
   * PER CURRENCY, and never summed across. Invoices carry their own currency
   * per row (this platform bills USD through Stripe beside a school's local
   * rail), so a single figure would be kobo added to cents — the mistake this
   * codebase has now recorded in eight places.
   *
   * BILLED is exact: it is the line items themselves. COLLECTED is not, and the
   * shape says so. A payment settles an INVOICE, not a line, so on an invoice
   * mixing tuition and hostel rent a part payment does not say which part it
   * paid. Each posted payment is apportioned across its invoice's lines pro
   * rata by amount, the ordinary convention for an unallocated receipt, and
   * exact wherever an invoice carries one department.
   *
   * // GOTCHA on the SHAPE, and it took measuring to get right. The first
   * version aggregated line items by (invoice, source) and then re-aggregated
   * to per-invoice — 180,000 intermediate rows to return four. Measured as
   * `major_user` with RLS in force on ten years of a school (60,015 invoices,
   * 72,271 lines, 45,141 payments): **1,328 ms -> 687 ms** by grouping the
   * final result directly by (currency, source) and joining per-invoice scalars
   * instead. A WINDOW-FUNCTION variant looked cleaner and measured WORSE
   * (2,522 ms), and a `scoped` CTE referenced three times materialised and was
   * worse again — both rejected on the numbers, not on taste.
   * `MIN(src) <> MAX(src)` replaces `COUNT(DISTINCT src)` for the mixed test.
   *
   * // WHERE THE CEILING IS, stated rather than implied. This is
   * O(THE SCHOOL'S LIFETIME): every line the school has ever raised is
   * aggregated, because the collected figure needs each invoice's own total to
   * apportion against. An ordinary school reads in tens of milliseconds. At the
   * fixture above — ten years, 60,015 invoices — it is **1,197 ms all-time and
   * 826 ms for one session**, and it will keep growing with the school's age.
   *
   * // THE `stranded` ARM IS 520 MS OF THAT (725 ms without it), and it stays,
   * because the alternative is a finance report quietly worth less than the
   * bank. Two cheaper shapes were built and measured and both were WORSE — an
   * anti-join with a correlated EXISTS over the CTE came out at 2,394 ms — so
   * the cost is the price of the correctness, not of a clumsy expression.
   *
   * // Two covering indexes were built and measured — 808 ms and 418 ms, about
   * a tenth — and NOT added: `payment` INCLUDE was never chosen at all, and an
   * index buying a tenth on the two hottest tables in the product is write
   * amplification. The same conclusion the invoice-list index reached.
   *
   * // GOTCHA: money the apportionment CANNOT REACH is still money received.
   * Two ways an invoice carries a posted payment with no denominator to share
   * it out by: it has NO line items at all, so there is nothing to join to; or
   * its lines sum to ZERO because a waiver cancelled them out, and
   * `NULLIF(inv_total, 0)` makes the share NULL. Both used to drop the payment
   * on the floor — seeded live, ₦5,000 posted against a lineless invoice and
   * the collected figure did not move. A finance report quietly worth less than
   * the bank is the confident-false-statement shape this codebase keeps
   * meeting, so the `stranded` arm surfaces it as UNATTRIBUTED: a number
   * somebody can go and look into rather than one that is simply absent.
   *
   * // GOTCHA: mixing is COMMON. The hostel and transport runs APPEND to a
   * family's existing DRAFT invoice when there is one — right, since the point
   * is one bill per family — so measured on real data 19 invoices carried more
   * than one department against 25 that did not. `mixedCollectedMinor` is
   * therefore a material share, not a footnote, and is reported so a convention
   * is never read as a measurement.
   */
  async revenueBySource(p: Principal, range?: { from?: string; to?: string }): Promise<FeeSourceReportDto[]> {
    if (!this.isBillingWide(p)) return [];
    const window = dateWindow(range?.from, range?.to);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = (await tx.$queryRaw`
        WITH inv AS (
          SELECT li."invoiceId",
                 SUM(li."amountMinor"::numeric * li.quantity) AS inv_total,
                 MIN(COALESCE(li."source", 'UNATTRIBUTED')) AS min_src,
                 MAX(COALESCE(li."source", 'UNATTRIBUTED')) AS max_src
          FROM "invoice_line_item" li
          GROUP BY 1
        ),
        paid AS (
          -- A REFUND subtracts, exactly as the invoice balance treats it.
          SELECT pm."invoiceId",
                 SUM(CASE WHEN pm.kind = 'REFUND' THEN -pm."amountMinor"::numeric ELSE pm."amountMinor"::numeric END) AS paid_total
          FROM "payment" pm
          WHERE pm.status = 'POSTED'
          GROUP BY 1
        ),
        apportioned AS (
          SELECT i.currency,
                 COALESCE(li."source", 'UNATTRIBUTED') AS source,
                 SUM(li."amountMinor"::numeric * li.quantity) AS billed,
                 SUM(li."amountMinor"::numeric * li.quantity * COALESCE(pd.paid_total, 0) / NULLIF(inv.inv_total, 0)) AS collected,
                 SUM(CASE WHEN inv.min_src <> inv.max_src
                          THEN li."amountMinor"::numeric * li.quantity * COALESCE(pd.paid_total, 0) / NULLIF(inv.inv_total, 0)
                          ELSE 0 END) AS mixed_collected,
                 COUNT(*)::bigint AS line_count
          FROM "invoice_line_item" li
          JOIN "invoice" i ON i.id = li."invoiceId" AND i.status <> 'CANCELLED'
          JOIN inv ON inv."invoiceId" = li."invoiceId"
          LEFT JOIN paid pd ON pd."invoiceId" = li."invoiceId"
          WHERE TRUE
            ${window.from ? Prisma.sql`AND i."createdAt" >= ${window.from}` : Prisma.empty}
            ${window.to ? Prisma.sql`AND i."createdAt" <= ${window.to}` : Prisma.empty}
          GROUP BY 1, 2
        ),
        -- Money the apportionment cannot reach; see the note above this method.
        stranded AS (
          SELECT i.currency,
                 'UNATTRIBUTED' AS source,
                 0::numeric AS billed,
                 SUM(pd.paid_total) AS collected,
                 0::numeric AS mixed_collected,
                 0::bigint AS line_count
          FROM paid pd
          JOIN "invoice" i ON i.id = pd."invoiceId"
          LEFT JOIN inv ON inv."invoiceId" = pd."invoiceId"
          WHERE i.status <> 'CANCELLED'
            AND COALESCE(inv.inv_total, 0) = 0
            ${window.from ? Prisma.sql`AND i."createdAt" >= ${window.from}` : Prisma.empty}
            ${window.to ? Prisma.sql`AND i."createdAt" <= ${window.to}` : Prisma.empty}
          GROUP BY 1, 2
        )
        SELECT currency,
               source,
               SUM(billed)::float8 AS billed,
               SUM(collected)::float8 AS collected,
               SUM(mixed_collected)::float8 AS mixed_collected,
               SUM(line_count)::int AS line_count
        FROM (SELECT * FROM apportioned UNION ALL SELECT * FROM stranded) x
        GROUP BY 1, 2
        ORDER BY 1, 3 DESC
      `) as Array<{
        currency: string;
        source: string;
        billed: number;
        collected: number | null;
        mixed_collected: number | null;
        line_count: number;
      }>;

      const byCurrency = new Map<string, FeeSourceReportDto>();
      for (const r of rows) {
        const entry =
          byCurrency.get(r.currency) ??
          ({
            currency: r.currency,
            sources: [],
            billedMinor: 0,
            collectedMinor: 0,
            outstandingMinor: 0,
            mixedCollectedMinor: 0,
          } satisfies FeeSourceReportDto);
        const billed = Math.round(r.billed);
        const collected = Math.round(r.collected ?? 0);
        entry.sources.push({
          source: r.source,
          label: FEE_SOURCE_LABELS[r.source as FeeSource] ?? "Not attributed",
          billedMinor: billed,
          collectedMinor: collected,
          // Never negative: a source over-collected through apportionment on a
          // mixed invoice would otherwise read as a debt owed TO the family.
          outstandingMinor: Math.max(0, billed - collected),
          lineCount: r.line_count,
        });
        entry.billedMinor += billed;
        entry.collectedMinor += collected;
        entry.outstandingMinor += Math.max(0, billed - collected);
        entry.mixedCollectedMinor += Math.round(r.mixed_collected ?? 0);
        byCurrency.set(r.currency, entry);
      }
      return [...byCurrency.values()];
    });
  }

  async financeReport(p: Principal) {
    if (!this.isBillingWide(p)) return { scope: "none" as const };
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Aging buckets are measured from the SCHOOL's today. The ladder is coarse
      // (0/30/60 days), so a UTC day boundary only ever moved an invoice one
      // bucket — but it moved it on the school's clock, not the server's, and a
      // finance report that disagrees with the calendar on the wall is one
      // nobody trusts twice.
      const today = await this.region.todayInTx(tx, p.schoolId);
      // Each bucket is (count, outstanding) over invoices with a POSITIVE
      // balance, split by how far past `today` the due date is — the same
      // days <= 0 / <= 30 / <= 60 / else ladder this replaces. Written out in
      // full rather than generated: a helper emitting two columns can only
      // alias one of them, and a mislabelled money column is silent.
      // GROUPED BY CURRENCY, in the same one pass.
      //
      // An invoice carries its own currency and a payment inherits its
      // invoice's, so the ungrouped `SUM("totalMinor")` this replaces added
      // kobo to cents and the page put one symbol in front of the result. The
      // group console had already worked this out for its cross-campus totals
      // ("a payment carries no currency of its own — it inherits its INVOICE's
      // ... precisely the assumption that made the old totals wrong") and the
      // school's own receivables report, which is the screen an accountant
      // actually reconciles against, was left as it was.
      //
      // It costs nothing: same scan, one small grouping, one round trip — and
      // a school billing in one currency gets exactly one row back.
      //
      // THE `net` CTE IS UNCORRELATED, AND THAT IS WORTH 1.8 SECONDS.
      //
      // It used to end `AND p."invoiceId" IN (SELECT id FROM billable)`, which
      // made the planner nested-loop `payment_invoiceId_idx` once PER INVOICE.
      // Measured as `major_user` with the tenant GUC set (never as `postgres`,
      // which bypasses RLS and plans differently), on ten years of a real
      // secondary school — 185,413 invoices, 156,537 payments:
      //
      //   IN-subquery    2,394 ms   185,413 index lookups, spilling to disk
      //   uncorrelated     571 ms   one hash aggregate over the school's payments
      //
      // This report is billing-wide by definition — a parent gets `scope: "none"`
      // — so there is no narrow case to preserve, unlike `invoiceSummary`, which
      // branches on scope for exactly that reason. RLS already confines
      // `payment` to this school; the subquery was never doing the scoping.
      const rows = (await tx.$queryRaw`
        WITH billable AS (
          SELECT id, currency, "totalMinor", "dueDate" FROM "invoice"
          WHERE status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID')
        ),
        net AS (
          SELECT p."invoiceId",
                 SUM(CASE WHEN p.kind = 'REFUND' THEN -p."amountMinor" ELSE p."amountMinor" END) AS paid
            FROM "payment" p
           WHERE p.status = 'POSTED'
           GROUP BY p."invoiceId"
        ),
        bal AS (
          SELECT b.currency,
                 b."totalMinor",
                 COALESCE(n.paid, 0) AS paid,
                 b."totalMinor" - COALESCE(n.paid, 0) AS balance,
                 (${today}::date - b."dueDate") AS days
            FROM billable b LEFT JOIN net n ON n."invoiceId" = b.id
        )
        SELECT
          currency,
          COALESCE(SUM("totalMinor"), 0)::float8 AS "invoicedMinor",
          COALESCE(SUM(paid), 0)::float8         AS "collectedMinor",
          count(*) FILTER (WHERE balance > 0 AND days <= 0)::int AS "currentCount",
          COALESCE(SUM(balance) FILTER (WHERE balance > 0 AND days <= 0), 0)::float8 AS "currentMinor",
          count(*) FILTER (WHERE balance > 0 AND days > 0 AND days <= 30)::int AS "d1_30Count",
          COALESCE(SUM(balance) FILTER (WHERE balance > 0 AND days > 0 AND days <= 30), 0)::float8 AS "d1_30Minor",
          count(*) FILTER (WHERE balance > 0 AND days > 30 AND days <= 60)::int AS "d31_60Count",
          COALESCE(SUM(balance) FILTER (WHERE balance > 0 AND days > 30 AND days <= 60), 0)::float8 AS "d31_60Minor",
          count(*) FILTER (WHERE balance > 0 AND days > 60)::int AS "d60plusCount",
          COALESCE(SUM(balance) FILTER (WHERE balance > 0 AND days > 60), 0)::float8 AS "d60plusMinor"
        FROM bal GROUP BY currency`) as Array<Record<string, number | string>>;
      // Pending approvals carry the currency of the invoice they sit on — the
      // maker-checker threshold is judged in the school's own money, so a
      // figure labelled with the wrong currency here misstates the control.
      const pending = (await tx.$queryRaw`
        SELECT i.currency, count(*)::int AS count, COALESCE(SUM(p."amountMinor"), 0)::float8 AS "amountMinor"
          FROM "payment" p JOIN "invoice" i ON i.id = p."invoiceId"
         WHERE p.status = 'PENDING_APPROVAL' GROUP BY i.currency`) as Array<{ currency: string; count: number; amountMinor: number }>;

      const schoolCurrency = (await tx.school.findFirst({ where: { id: p.schoolId }, select: { currency: true } }))?.currency
        ?? PLATFORM_HOME_CURRENCY;
      const byCurrency: FeeCurrencyReportDto[] = rows.map((raw) => {
        const n = (k: string) => Number(raw[k] ?? 0);
        const invoiced = n("invoicedMinor");
        const collected = n("collectedMinor");
        return {
          currency: String(raw.currency ?? schoolCurrency),
          totals: { invoicedMinor: invoiced, collectedMinor: collected, outstandingMinor: invoiced - collected },
          aging: {
            current: { count: n("currentCount"), amountMinor: n("currentMinor") },
            d1_30: { count: n("d1_30Count"), amountMinor: n("d1_30Minor") },
            d31_60: { count: n("d31_60Count"), amountMinor: n("d31_60Minor") },
            d60plus: { count: n("d60plusCount"), amountMinor: n("d60plusMinor") },
          },
        };
      });
      // The school's own currency FIRST and always present, even at zero: the
      // headline block is what the page reads, and a school that happens to
      // have raised only dollar invoices this term must not have a USD figure
      // promoted into the position its staff read as "our money".
      const empty: FeeCurrencyReportDto = {
        currency: schoolCurrency,
        totals: { invoicedMinor: 0, collectedMinor: 0, outstandingMinor: 0 },
        aging: {
          current: { count: 0, amountMinor: 0 },
          d1_30: { count: 0, amountMinor: 0 },
          d31_60: { count: 0, amountMinor: 0 },
          d60plus: { count: 0, amountMinor: 0 },
        },
      };
      const home = byCurrency.find((b) => b.currency === schoolCurrency) ?? empty;
      const ordered = [home, ...byCurrency.filter((b) => b.currency !== schoolCurrency).sort((a, b) => a.currency.localeCompare(b.currency))];
      return {
        scope: "school" as const,
        currency: schoolCurrency,
        totals: home.totals,
        aging: home.aging,
        byCurrency: ordered,
        pendingApprovals: {
          count: pending.find((x) => x.currency === schoolCurrency)?.count ?? 0,
          amountMinor: Number(pending.find((x) => x.currency === schoolCurrency)?.amountMinor ?? 0),
          byCurrency: pending
            .map((x) => ({ currency: x.currency, count: Number(x.count), amountMinor: Number(x.amountMinor) }))
            .sort((a, b) => (a.currency === schoolCurrency ? -1 : b.currency === schoolCurrency ? 1 : a.currency.localeCompare(b.currency))),
        },
      };
    });
  }

  /**
   * Invoices, filtered and PAGED.
   *
   * This was a flat `take: 200` with no way to reach past it, and the page passed no
   * filters at all — so an accountant saw the 200 most recent invoices and older ones
   * were simply unreachable from the fees page. A term's billing for a few hundred
   * students exceeds that in one issue run.
   *
   * `q` matches the reference, which is how staff actually look an invoice up: a
   * parent quotes "INV-2041" off their copy, not a student id.
   *
   * Paging is by CURSOR on (createdAt, id) rather than an offset. Offsets shift when
   * a new invoice is issued mid-browse, which silently skips or repeats rows on the
   * next page — for a financial list that is not cosmetic.
   */
  async listInvoices(
    p: Principal,
    opts?: { studentId?: string; status?: InvoiceStatusValue; q?: string; cursor?: string; limit?: number },
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts?.limit ?? INVOICE_PAGE_SIZE, 1), INVOICE_PAGE_MAX);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where: Record<string, unknown> = {};
      if (opts?.status) where.status = opts.status;
      const q = opts?.q?.trim();
      if (q) where.reference = { contains: q, mode: "insensitive" };

      if (this.isBillingWide(p)) {
        if (opts?.studentId) where.studentId = opts.studentId;
      } else {
        const ids = await this.visibleStudentIds(tx, p);
        if (ids.length === 0) return { items: [], nextCursor: null };
        where.studentId = opts?.studentId && ids.includes(opts.studentId)
          ? opts.studentId
          : { in: ids };
        // A DRAFT IS NOT A BILL YET, so a family must not be shown one.
        //
        // There was no default status filter, so every status came back to
        // whoever asked. Finance staff need that — a draft is one they are
        // writing. A parent seeing it is being shown a charge the school has
        // not issued: the amount can still change, lines can be added, and it
        // may never be sent. Proven against the running system — a freshly
        // created DRAFT appeared in the parent's own invoice list.
        //
        // CANCELLED stays visible on purpose. A withdrawn charge is part of the
        // family's history and hiding it invites "what happened to that bill?";
        // what it must not be is PAYABLE, which is guarded at pay/init.
        // Applied UNCONDITIONALLY, not only when no status was asked for:
        // `?status=DRAFT` would otherwise hand back exactly what this hides.
        where.status = opts?.status && opts.status !== "DRAFT" ? opts.status : { not: "DRAFT" };
      }

      // Fetch one extra to learn whether another page exists without a second query.
      const rows = (await tx.invoice.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(opts?.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      })) as Array<{ id: string }>;

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
    });
  }

  /**
   * The three numbers a fees page is opened for: outstanding, collected, overdue.
   *
   * Computed as ONE aggregate in Postgres over the caller's visible set, never by
   * summing the rows the page happens to be showing — with paging in place those are
   * one page of many, and a total derived from a page is simply wrong.
   *
   * Money is cast to ::float8 deliberately, matching the analytics aggregate: a
   * school's lifetime kobo total overflows int4, and int8 comes back as BigInt which
   * the JSON layer cannot serialize. float8 is exact well past any real total.
   */
  async invoiceSummary(p: Principal): Promise<InvoiceSummaryDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const schoolCurrency =
        (await tx.school.findFirst({ where: { id: p.schoolId }, select: { currency: true } }))?.currency ?? PLATFORM_HOME_CURRENCY;
      const none: InvoiceSummaryDto = {
        outstandingMinor: 0,
        collectedMinor: 0,
        overdueCount: 0,
        currency: schoolCurrency,
        byCurrency: [{ currency: schoolCurrency, outstandingMinor: 0, collectedMinor: 0, overdueCount: 0 }],
      };
      // Scope first: a parent's summary must cover only their children.
      let studentFilter = Prisma.sql``;
      const wide = this.isBillingWide(p);
      if (!wide) {
        const ids = await this.visibleStudentIds(tx, p);
        if (ids.length === 0) return none;
        // = ANY(ARRAY[...]) rather than IN (...): with Prisma.join, `IN (a,b,c)::uuid[]`
        // applies the cast to the LAST element only and Postgres rejects it
        // (42883, uuid = uuid[]). Only the parent-scoped path builds this clause, so
        // the staff path would have kept working while every parent got a 500.
        studentFilter = Prisma.sql`AND i."studentId" = ANY(ARRAY[${Prisma.join(ids)}]::uuid[])`;
      }

      // THE PAYMENT AGGREGATE IS CHOSEN BY SCOPE, and the difference is 2.3
      // SECONDS on every load of /fees and /admin.
      //
      // `IN (SELECT id FROM billable)` made the planner nested-loop the payment
      // index once PER INVOICE. Measured as `major_user` with the tenant GUC set
      // (never as `postgres`), on ten years of a real secondary school —
      // 185,413 invoices, 156,537 payments:
      //
      //   whole school, IN-subquery  2,280 ms   185,413 index lookups, 712k buffers, spilling to disk
      //   whole school, uncorrelated   542 ms   one hash aggregate over the school's payments
      //   one family,   IN-subquery      5 ms   the loop is over a handful of invoices
      //   one family,   uncorrelated   228 ms   aggregating the WHOLE school to answer about one child
      //
      // Neither form wins both, so the scope the method already knows picks
      // one. RLS confines `payment` to this school either way; the subquery was
      // never doing the scoping, only the planner's arm-twisting.
      //
      // // GOTCHA: covering indexes were built and measured alongside
      // (`payment (invoiceId) INCLUDE (amountMinor, kind) WHERE status='POSTED'`
      // and an invoice equivalent) and the planner NEVER chose the invoice one;
      // the pair moved 542 ms to 448 ms, inside the noise. An index nothing
      // selects is storage and write amplification on the two hottest tables in
      // the product — the same conclusion as the three trigram indexes dropped
      // in 20261228000000. Neither is added.
      const paidScope = wide ? Prisma.sql`` : Prisma.sql` AND p."invoiceId" IN (SELECT id FROM billable)`;
      // GROUPED BY CURRENCY — one extra column on the same scan.
      const rows = (await tx.$queryRaw`
        WITH billable AS (
          SELECT i.id, i.currency, i."totalMinor", i."dueDate", i.status
          FROM invoice i
          WHERE i.status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID')
          ${studentFilter}
        ), paid AS (
          SELECT p."invoiceId",
                 SUM(CASE WHEN p.kind = 'REFUND' THEN -p."amountMinor" ELSE p."amountMinor" END) AS amt
          FROM payment p
          WHERE p.status = 'POSTED'${paidScope}
          GROUP BY p."invoiceId"
        )
        SELECT
          b.currency,
          COALESCE(SUM(b."totalMinor" - COALESCE(pd.amt, 0)), 0)::float8 AS "outstandingMinor",
          COALESCE(SUM(COALESCE(pd.amt, 0)), 0)::float8                  AS "collectedMinor",
          COUNT(*) FILTER (
            WHERE b."dueDate" IS NOT NULL
              AND b."dueDate" < now()
              AND b."totalMinor" - COALESCE(pd.amt, 0) > 0
          )::int AS "overdueCount"
        FROM billable b
        LEFT JOIN paid pd ON pd."invoiceId" = b.id
        GROUP BY b.currency
      `) as Array<{ currency: string; outstandingMinor: number; collectedMinor: number; overdueCount: number }>;

      const byCurrency = rows.map((r) => ({
        currency: r.currency || schoolCurrency,
        outstandingMinor: Math.round(Number(r.outstandingMinor)),
        collectedMinor: Math.round(Number(r.collectedMinor)),
        overdueCount: Number(r.overdueCount),
      }));
      // The school's own currency is the headline and is always present, even at
      // zero — the tiles on /admin and /fees read it as "our money", and
      // promoting a USD figure into that slot because it happened to be the only
      // one this term would be the same wrong answer in a new place.
      const home = byCurrency.find((b) => b.currency === schoolCurrency) ?? none.byCurrency[0];
      return {
        ...home,
        currency: schoolCurrency,
        byCurrency: [home, ...byCurrency.filter((b) => b.currency !== schoolCurrency).sort((a, b) => a.currency.localeCompare(b.currency))],
      };
    });
  }

  async getInvoice(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const inv = await this.loadInvoice(tx, id);
      if (!inv) throw new NotFoundException("Invoice not found");
      await this.assertCanAccessStudent(tx, p, inv.studentId);
      return this.withBalance(inv);
    });
  }

  // --- payments (maker-checker) ----------------------------------------------
  /** Record a payment or refund. Large payments and ALL refunds post as
   *  PENDING_APPROVAL and don't change the balance until a different staff
   *  member approves them. */
  async recordPayment(p: Principal, invoiceId: string, input: PaymentInput) {
    if (input.amountMinor <= 0) throw new BadRequestException("amountMinor must be > 0");
    const kind = input.kind ?? "PAYMENT";

    const result = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Serialize concurrent recorders on THIS invoice by locking its row for
      // the rest of the transaction — the overpayment check below is a
      // read-then-insert, so two racing recorders could otherwise both pass it
      // and post more than the outstanding balance. (Mirrors the hostel
      // capacity lock; RLS still applies.)
      await tx.$executeRaw`SELECT id FROM "invoice" WHERE id = ${invoiceId}::uuid FOR UPDATE`;
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId } });
      if (!inv) throw new NotFoundException("Invoice not found");

      // THE THRESHOLD IS CUMULATIVE. Judged per payment it is trivially evaded:
      // two of NGN 30,000 post immediately where one of NGN 60,000 waits for a
      // second pair of eyes. Confirmed live — same amount, same person, same
      // invoice, one route through the control and one straight past it, and
      // the invoice moved to PARTIALLY_PAID off the split.
      //
      // Read inside the FOR UPDATE above, so two concurrent recorders cannot
      // each see the other's total as absent and both slip under.
      const since = new Date(Date.now() - PAYMENT_APPROVAL_WINDOW_HOURS * 60 * 60 * 1000);
      const recent = (await tx.payment.aggregate({
        where: { invoiceId, status: "POSTED", createdAt: { gte: since } },
        _sum: { amountMinor: true },
      })) as { _sum: { amountMinor: number | null } };
      // THE THRESHOLD IS THE SCHOOL'S, IN THE SCHOOL'S OWN CURRENCY.
      //
      // It was a single naira constant applied to every school: 5,000,000 minor
      // units, which is ₦50,000 as intended and £50,000 in a British school —
      // a two-person rule that never fires, on a screen still saying large
      // payments need a second signature. There is no FX rate here and
      // inventing one to convert a control would be worse than the bug, so the
      // school states the figure and an unset one FAILS TIGHT.
      const school = await tx.school.findFirst({
        where: { id: p.schoolId },
        select: { paymentApprovalThresholdMinor: true, currency: true },
      });
      const thresholdMinor = effectivePaymentApprovalThresholdMinor({
        configuredMinor: school?.paymentApprovalThresholdMinor,
        currency: school?.currency,
      });
      const needsApproval = paymentNeedsApproval({
        kind,
        amountMinor: input.amountMinor,
        recentPostedMinor: recent._sum.amountMinor ?? 0,
        thresholdMinor,
      });
      if (inv.status === "DRAFT") throw new BadRequestException("Issue the invoice before recording payment");
      if (inv.status === "CANCELLED") throw new BadRequestException("Invoice is cancelled");
      if (inv.status === "PAID" && kind === "PAYMENT") {
        throw new BadRequestException("Invoice is already paid");
      }

      const paid = await this.paidMinor(tx, invoiceId); // net of POSTED only
      if (kind === "PAYMENT" && input.amountMinor > inv.totalMinor - paid) {
        throw new BadRequestException(`Payment exceeds the outstanding balance ${inv.totalMinor - paid}`);
      }
      if (kind === "REFUND" && input.amountMinor > paid) {
        throw new BadRequestException(`Refund exceeds the amount paid ${paid}`);
      }

      const payment = await tx.payment.create({
        data: {
          schoolId: p.schoolId,
          invoiceId,
          amountMinor: input.amountMinor,
          method: input.method,
          kind,
          status: needsApproval ? "PENDING_APPROVAL" : "POSTED",
          reference: input.reference ?? null,
          note: input.note ?? null,
          paidAt: input.paidAt ? new Date(input.paidAt) : new Date(),
          recordedById: p.userId,
        },
      });

      let invoice = inv;
      const netAfter = kind === "REFUND" ? paid - input.amountMinor : paid + input.amountMinor;
      if (!needsApproval) {
        invoice = await this.applyToInvoiceStatus(tx, inv, netAfter);
      }
      await this.log(tx, p, "fee.payment.record", "invoice", invoiceId, {
        kind,
        amountMinor: input.amountMinor,
        method: input.method,
        status: payment.status,
      });
      return { payment, invoice, posted: !needsApproval, balanceAfter: inv.totalMinor - netAfter };
    });

    // EVERY posted payment gets a receipt — partial payments included.
    if (result.posted) {
      await this.sendPaymentReceipt(
        p,
        result.invoice,
        { amountMinor: input.amountMinor, method: input.method, reference: input.reference, kind },
        result.balanceAfter,
      );
    }
    return result.payment;
  }

  /** The approver queue: all PENDING_APPROVAL payments in the tenant. */
  async listPendingPayments(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.payment.findMany({
        where: { status: "PENDING_APPROVAL" },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    );
  }

  async approvePayment(p: Principal, paymentId: string) {
    const result = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const pay = await tx.payment.findFirst({ where: { id: paymentId } });
      if (!pay) throw new NotFoundException("Payment not found");
      if (pay.status !== "PENDING_APPROVAL") throw new BadRequestException("Payment is not pending");
      // SECURITY: separation of duties — the approver must differ from the recorder.
      if (pay.recordedById === p.userId) {
        throw new ForbiddenException("You cannot approve a payment you recorded");
      }
      // Same invoice lock as recordPayment — the status recomputation below
      // reads the posted total, so concurrent decisions must queue.
      await tx.$executeRaw`SELECT id FROM "invoice" WHERE id = ${pay.invoiceId}::uuid FOR UPDATE`;
      // Optimistic claim: two staff deciding the same payment at once — only
      // the first write lands; the loser matches 0 rows and is told so.
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, status: "PENDING_APPROVAL" },
        data: { status: "POSTED", approvedById: p.userId },
      });
      if (claimed.count === 0) throw new BadRequestException("Payment is not pending");
      const inv = await tx.invoice.findFirst({ where: { id: pay.invoiceId } });
      if (!inv) throw new NotFoundException("Invoice not found");
      const net = await this.paidMinor(tx, pay.invoiceId);
      const invoice = await this.applyToInvoiceStatus(tx, inv, net);
      await this.log(tx, p, "fee.payment.approve", "invoice", pay.invoiceId, {
        paymentId,
        kind: pay.kind,
        amountMinor: pay.amountMinor,
      });
      // For an approved CARD refund, locate the ORIGINAL card charge so the
      // money can be pushed back to the same card via the gateway. The most
      // recent POSTED card payment with enough value is the anchor.
      let gatewayRef: string | null = null;
      if (pay.kind === "REFUND") {
        const original = await tx.payment.findFirst({
          where: {
            invoiceId: pay.invoiceId,
            kind: "PAYMENT",
            method: "CARD",
            status: "POSTED",
            reference: { not: null },
            amountMinor: { gte: pay.amountMinor },
          },
          orderBy: { createdAt: "desc" },
          select: { reference: true },
        });
        gatewayRef = original?.reference ?? null;
      }
      return {
        invoice,
        payment: { amountMinor: pay.amountMinor, method: pay.method, reference: pay.reference, kind: pay.kind },
        balanceAfter: inv.totalMinor - net,
        gatewayRef,
      };
    });

    // Gateway-executed refund: push the money back to the ORIGINAL card. The
    // ledger decision above is committed either way (a business decision); if
    // the gateway push fails or isn't possible (cash payment / gateway unset),
    // the approver is told explicitly to return the funds manually — never
    // silent, never redirectable to a different account.
    let refundNote = "";
    if (result.payment.kind === "REFUND") {
      if (result.gatewayRef && this.paystack.isConfigured()) {
        const pushed = await this.paystack.refund({
          transactionReference: result.gatewayRef,
          amountMinor: result.payment.amountMinor,
        });
        await this.db.runAsTenant(this.ctx(p), (tx) =>
          this.log(tx, p, pushed.ok ? "fee.refund.gateway" : "fee.refund.gateway.failed", "invoice", result.invoice.id, {
            paymentId,
            transactionReference: result.gatewayRef,
            amountMinor: result.payment.amountMinor,
            ...(pushed.error ? { error: pushed.error } : {}),
          }),
        );
        refundNote = pushed.ok
          ? " The money is being returned to the original card by the payment provider."
          : " Automatic card refund FAILED — the school will return the funds manually.";
        if (!pushed.ok) {
          // Tell the approver immediately; the audit entry has the details.
          try {
            await this.notifications.enqueue(this.ctx(p), {
              recipientId: p.userId,
              type: "BILLING",
              title: "Card refund needs manual action",
              body: `The gateway refund for invoice ${result.invoice.reference} (${this.money(result.payment.amountMinor, result.invoice.currency)}) failed — return the funds manually and keep the transfer evidence.`,
              channels: ["EMAIL"],
            });
          } catch {
            // best-effort
          }
        }
      } else {
        refundNote = " The school will return the funds to you directly.";
      }
    }
    // Approved payments AND refunds both notify — partial or full.
    await this.sendPaymentReceipt(p, result.invoice, result.payment, result.balanceAfter, refundNote);
    return { id: paymentId, status: "POSTED" };
  }

  async rejectPayment(p: Principal, paymentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const pay = await tx.payment.findFirst({ where: { id: paymentId } });
      if (!pay) throw new NotFoundException("Payment not found");
      if (pay.status !== "PENDING_APPROVAL") throw new BadRequestException("Payment is not pending");
      // Optimistic claim — a reject racing an approve (or another reject) must
      // never overwrite a decision that already landed.
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, status: "PENDING_APPROVAL" },
        data: { status: "REJECTED", approvedById: p.userId },
      });
      if (claimed.count === 0) throw new BadRequestException("Payment is not pending");
      await this.log(tx, p, "fee.payment.reject", "invoice", pay.invoiceId, { paymentId });
      return { id: paymentId, status: "REJECTED" };
    });
  }

  /** Recompute invoice status from a net-paid figure (PAID / PARTIALLY_PAID / ISSUED). */
  private async applyToInvoiceStatus(tx: TenantTx, inv: { id: string; totalMinor: number }, net: number) {
    const status: InvoiceStatusValue = net >= inv.totalMinor ? "PAID" : net > 0 ? "PARTIALLY_PAID" : "ISSUED";
    return tx.invoice.update({ where: { id: inv.id }, data: { status } });
  }

  /**
   * Universal payment receipt: EVERY posted payment (manual or online, partial
   * or full) notifies the guardians AND the student (in-app + email) with the
   * amount, method, reference and the NEW balance. Refunds send a refund notice.
   * Best-effort — never fails the financial action.
   */
  private async sendPaymentReceipt(
    p: Principal,
    invoice: { id: string; studentId: string; reference: string; currency: string; totalMinor: number },
    payment: { amountMinor: number; method: string; reference?: string | null; kind: string },
    balanceAfter: number,
    extraLine = "",
  ) {
    const amount = this.money(payment.amountMinor, invoice.currency);
    const isRefund = payment.kind === "REFUND";
    const balanceLine =
      balanceAfter <= 0
        ? "The invoice is now fully paid. Thank you."
        : `Outstanding balance: ${this.money(balanceAfter, invoice.currency)}.`;
    await this.notifyGuardians(
      p,
      invoice.studentId,
      {
        type: "PAYMENT_RECEIVED",
        title: isRefund ? "Refund processed" : "Payment receipt — successful",
        body:
          `${isRefund ? "A refund of" : "We received"} ${amount} on invoice ${invoice.reference} ` +
          `(${payment.method.toLowerCase()}${payment.reference ? `, ref ${payment.reference}` : ""}). ${balanceLine}${extraLine}`,
        data: { invoiceId: invoice.id, reference: invoice.reference, amountMinor: payment.amountMinor },
      },
      [invoice.studentId],
    );
  }

  async listPayments(p: Principal, invoiceId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const inv = await tx.invoice.findFirst({
        where: { id: invoiceId },
        select: { studentId: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      await this.assertCanAccessStudent(tx, p, inv.studentId);
      return tx.payment.findMany({ where: { invoiceId }, orderBy: { paidAt: "desc" } });
    });
  }

  // --- helpers ---------------------------------------------------------------
  private assertNonNegative(n: number, field: string) {
    if (!Number.isInteger(n) || n < 0) {
      throw new BadRequestException(`${field} must be a non-negative integer (minor units)`);
    }
  }

  private genReference(): string {
    return `INV-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
  }

  private money(minor: number, currency: string): string {
    return formatMoney(minor, currency);
  }
  private dateOnly(d: Date): string {
    return new Date(d).toISOString().slice(0, 10);
  }

  /** Net amount paid: POSTED payments minus POSTED refunds. PENDING_APPROVAL and
   *  REJECTED rows never count toward the balance. */
  private async paidMinor(tx: TenantTx, invoiceId: string): Promise<number> {
    const posted = await tx.payment.findMany({
      where: { invoiceId, status: "POSTED" },
      select: { amountMinor: true, kind: true },
    });
    return posted.reduce(
      (n: number, pmt: { amountMinor: number; kind: string }) =>
        n + (pmt.kind === "REFUND" ? -pmt.amountMinor : pmt.amountMinor),
      0,
    );
  }

  private async loadInvoice(tx: TenantTx, id: string) {
    return tx.invoice.findFirst({
      where: { id },
      include: { lineItems: true, payments: { orderBy: { paidAt: "desc" } } },
    });
  }

  private withBalance<
    T extends {
      totalMinor: number;
      status: string;
      dueDate: Date;
      payments: { amountMinor: number; kind: string; status: string }[];
    },
  >(inv: T) {
    const amountPaidMinor = inv.payments
      .filter((pmt) => pmt.status === "POSTED")
      .reduce((n, pmt) => n + (pmt.kind === "REFUND" ? -pmt.amountMinor : pmt.amountMinor), 0);
    const pendingApprovalMinor = inv.payments
      .filter((pmt) => pmt.status === "PENDING_APPROVAL")
      .reduce((n, pmt) => n + pmt.amountMinor, 0);
    const balanceMinor = inv.totalMinor - amountPaidMinor;
    const overdue =
      balanceMinor > 0 &&
      inv.status !== "PAID" &&
      inv.status !== "CANCELLED" &&
      new Date(inv.dueDate) < new Date(this.dateOnly(new Date()));
    return { ...inv, amountPaidMinor, balanceMinor, pendingApprovalMinor, overdue };
  }

  /** The studentIds a non-billing-wide caller may see (own / their children). */
  private async visibleStudentIds(tx: TenantTx, p: Principal): Promise<string[]> {
    const ids = new Set<string>();
    if (p.roles.includes("student")) ids.add(p.userId);
    const links = await tx.parentChild.findMany({
      where: { parentId: p.userId },
      select: { studentId: true },
    });
    links.forEach((l: { studentId: string }) => ids.add(l.studentId));
    return [...ids];
  }

  private async assertCanAccessStudent(tx: TenantTx, p: Principal, studentId: string) {
    if (this.isBillingWide(p)) return;
    if (p.userId === studentId) return;
    const link = await tx.parentChild.findFirst({
      where: { parentId: p.userId, studentId },
      select: { id: true },
    });
    if (link) return;
    // SECURITY: 404, not 403 — never reveal another family's invoice.
    throw new NotFoundException("Invoice not found");
  }

  private async notifyGuardians(
    p: Principal,
    studentId: string,
    msg: { type: string; title: string; body: string; data?: Record<string, unknown> },
    extraRecipientIds: string[] = [],
  ) {
    try {
      const guardians = await this.db.runAsTenant(this.ctx(p), (tx) =>
        tx.parentChild.findMany({ where: { studentId }, select: { parentId: true } }),
      );
      const recipients = [
        ...new Set([...(guardians as { parentId: string }[]).map((g) => g.parentId), ...extraRecipientIds]),
      ];
      for (const recipientId of recipients) {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId,
          type: msg.type,
          title: msg.title,
          body: msg.body,
          data: msg.data,
          channels: ["EMAIL"],
        });
      }
    } catch (err) {
      // Best-effort: a notification failure never fails the financial action.
      this.logger.error(`Fees notification failed for student ${studentId}: ${String(err)}`);
    }
  }

  private async log(
    tx: TenantTx,
    p: Principal,
    action: string,
    entity: string,
    entityId: string,
    metadata?: Record<string, unknown>,
  ) {
    await this.audit.record(
      { actorId: p.userId, action, entity, entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
