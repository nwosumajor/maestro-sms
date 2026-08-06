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
  PAYMENT_APPROVAL_THRESHOLD_MINOR,
  PAYMENT_APPROVAL_WINDOW_HOURS,
  paymentNeedsApproval,
  type InvoiceStatusValue,
  type PaymentMethodValue,
} from "@sms/types";
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

/** Roles that see ALL billing rows in the tenant. */
/** Invoices per page. One issue run for a class is ~30-40 rows, so a page shows a
 *  class's worth at a time. */
const INVOICE_PAGE_SIZE = 50;
/** Ceiling a caller can request per page. */
const INVOICE_PAGE_MAX = 200;

const BILLING_WIDE_ROLES = new Set([
  "accountant",
  "school_admin",
  "principal",
  "board",
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
        select: { id: true, studentId: true, reference: true, totalMinor: true, dueDate: true },
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
        .map((inv: { id: string; studentId: string; reference: string; totalMinor: number; dueDate: Date }) => ({
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
        body: `Invoice ${inv.reference} has an outstanding balance of ${(inv.outstanding / 100).toFixed(2)}${overdue ? ` (due ${inv.dueDate.toISOString().slice(0, 10)})` : ""}.`,
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

  /** Receivables aging + collection summary (billing-wide staff/board only). */
  async financeReport(p: Principal) {
    if (!this.isBillingWide(p)) return { scope: "none" as const };
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const invoices = await tx.invoice.findMany({
        where: { status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] } },
        include: { payments: { where: { status: "POSTED" }, select: { amountMinor: true, kind: true } } },
      });
      const mk = () => ({ count: 0, amountMinor: 0 });
      const bucket = { current: mk(), d1_30: mk(), d31_60: mk(), d60plus: mk() };
      let invoiced = 0;
      let collected = 0;
      const today = new Date(new Date().toISOString().slice(0, 10));
      for (const inv of invoices as Array<{ totalMinor: number; dueDate: Date; payments: { amountMinor: number; kind: string }[] }>) {
        const paid = inv.payments.reduce((n, x) => n + (x.kind === "REFUND" ? -x.amountMinor : x.amountMinor), 0);
        invoiced += inv.totalMinor;
        collected += paid;
        const balance = inv.totalMinor - paid;
        if (balance <= 0) continue;
        const days = Math.floor((today.getTime() - new Date(inv.dueDate).getTime()) / 86_400_000);
        const b = days <= 0 ? bucket.current : days <= 30 ? bucket.d1_30 : days <= 60 ? bucket.d31_60 : bucket.d60plus;
        b.count += 1;
        b.amountMinor += balance;
      }
      const pending = await tx.payment.findMany({ where: { status: "PENDING_APPROVAL" }, select: { amountMinor: true } });
      return {
        scope: "school" as const,
        totals: { invoicedMinor: invoiced, collectedMinor: collected, outstandingMinor: invoiced - collected },
        aging: bucket,
        pendingApprovals: { count: pending.length, amountMinor: pending.reduce((n: number, x: { amountMinor: number }) => n + x.amountMinor, 0) },
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
  async invoiceSummary(
    p: Principal,
  ): Promise<{ outstandingMinor: number; collectedMinor: number; overdueCount: number; currency: string }> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      // Scope first: a parent's summary must cover only their children.
      let studentFilter = Prisma.sql``;
      if (!this.isBillingWide(p)) {
        const ids = await this.visibleStudentIds(tx, p);
        if (ids.length === 0) return { outstandingMinor: 0, collectedMinor: 0, overdueCount: 0, currency: "NGN" };
        // = ANY(ARRAY[...]) rather than IN (...): with Prisma.join, `IN (a,b,c)::uuid[]`
        // applies the cast to the LAST element only and Postgres rejects it
        // (42883, uuid = uuid[]). Only the parent-scoped path builds this clause, so
        // the staff path would have kept working while every parent got a 500.
        studentFilter = Prisma.sql`AND i."studentId" = ANY(ARRAY[${Prisma.join(ids)}]::uuid[])`;
      }

      const rows = (await tx.$queryRaw`
        WITH billable AS (
          SELECT i.id, i."totalMinor", i."dueDate", i.status
          FROM invoice i
          WHERE i.status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID')
          ${studentFilter}
        ), paid AS (
          SELECT p."invoiceId",
                 SUM(CASE WHEN p.kind = 'REFUND' THEN -p."amountMinor" ELSE p."amountMinor" END) AS amt
          FROM payment p
          WHERE p.status = 'POSTED' AND p."invoiceId" IN (SELECT id FROM billable)
          GROUP BY p."invoiceId"
        )
        SELECT
          COALESCE(SUM(b."totalMinor" - COALESCE(pd.amt, 0)), 0)::float8 AS "outstandingMinor",
          COALESCE(SUM(COALESCE(pd.amt, 0)), 0)::float8                  AS "collectedMinor",
          COUNT(*) FILTER (
            WHERE b."dueDate" IS NOT NULL
              AND b."dueDate" < now()
              AND b."totalMinor" - COALESCE(pd.amt, 0) > 0
          )::int AS "overdueCount"
        FROM billable b
        LEFT JOIN paid pd ON pd."invoiceId" = b.id
      `) as Array<{ outstandingMinor: number; collectedMinor: number; overdueCount: number }>;

      const r = rows[0] ?? { outstandingMinor: 0, collectedMinor: 0, overdueCount: 0 };
      return {
        outstandingMinor: Math.round(r.outstandingMinor),
        collectedMinor: Math.round(r.collectedMinor),
        overdueCount: r.overdueCount,
        // The ledger is single-currency per school in practice; USD invoices are a
        // per-invoice rail, so the headline figure follows the school's default.
        currency: "NGN",
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
      const needsApproval = paymentNeedsApproval({
        kind,
        amountMinor: input.amountMinor,
        recentPostedMinor: recent._sum.amountMinor ?? 0,
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
    return `${currency} ${(minor / 100).toFixed(2)}`;
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
