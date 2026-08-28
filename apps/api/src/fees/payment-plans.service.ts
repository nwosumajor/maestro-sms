import { PAYMENT_CHANNELS, formatMoney } from "@sms/types";
// =============================================================================
// PaymentPlansService — installment schedules + the student credit ledger
// =============================================================================
// Two halves of "pay on your own terms":
//   INSTALLMENTS — staff put a tranche schedule on an issued invoice (sum must
//   equal the total; replaced wholesale). Tranche state is DERIVED from
//   cumulative POSTED payments — the plan never moves money, it only frames
//   the existing balance, so partial payments keep working exactly as before.
//   CREDIT LEDGER — append-only entries per student: PREPAYMENT (parent pays
//   ahead via checkout, or an unmatched dedicated-account transfer),
//   OVERPAYMENT (excess moved OFF an invoice — as a double-entry: a POSTED
//   system REFUND on the source invoice balances the move so school-wide
//   collections never double-count), APPLIED (negative — consumed by a CREDIT
//   payment on a target invoice). Balance = SUM of immutable entries.
// SECURITY: the overpayment move posts a REFUND row directly (not through the
// maker-checker path) — deliberately: no money LEAVES the school, it moves
// from one student ledger bucket to another, staff-initiated and audited.
// Actual outbound refunds still go through maker-checker unchanged.
//
// EVERY ENTRY CARRIES ITS CURRENCY, and the balance is asked one currency at a
// time. `deltaMinor` on its own is a number of minor units and nothing said of
// what: an OVERPAYMENT is in the source INVOICE's currency, a dedicated-account
// transfer is in the CHARGE's, and APPLIED spends into the TARGET invoice's.
// Invoices carry their own currency per row — a school bills USD through Stripe
// alongside its local currency — so a single summed balance mixed two kinds of
// money. Measured live: $100.00 of overpayment became a credit of 10,000 and
// went onto a naira bill as ₦100, with every screen reporting success.
// `initPrepay` alone had seen this and says so in a comment ("crediting a
// ledger in one currency from a charge in another is a balance that silently
// drifts") — it raises its charge in the school's currency, which fixes ONE of
// the four producers and neither of the two consumers.
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException, Optional} from "@nestjs/common";
import type { CreditBalanceDto, InstallmentDto, PaymentPlanDto } from "@sms/types";
import { SchoolRegionService } from "../foundation/school-region.service";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";
import { netPaidMinor } from "./net-paid";
import { NotificationService } from "../notifications/notification.service";
import { PaystackService, type PaystackEvent } from "../payments/paystack.service";
import { PaymentChannelService } from "../payments/payment-channel.service";
import { publicWebUrl } from "../common/public-url";

// SECURITY: no super_admin. A platform user has NO standing role scope over a
// tenant's data — the supported route to it is impersonation, which is step-up
// gated, time limited and audited against the operator by name. This set was the
// last survivor of the 31 that were removed, missed because it is a plain array
// while the gate only matched `new Set([...])`.
const STAFF_WIDE = ["accountant", "school_admin", "principal"];

/**
 * The currency a ledger entry is in. NULL means the school's own currency:
 * rows written before the column existed cannot say what they were, and that is
 * the only assumption the data supports — it is the one `initPrepay` has always
 * raised its charges in. Named rather than inlined so the two readers and the
 * export cannot each decide it differently.
 */
export function creditEntryCurrency(entryCurrency: string | null, schoolCurrency: string): string {
  return entryCurrency ?? schoolCurrency;
}

/**
 * Rows in ONE currency. A NULL row belongs to the school's own currency and to
 * no other, so the school's currency is the one case that must also match NULL
 * — writing `{ currency }` alone would make every historical row unspendable,
 * which is a family's money stuck on a screen that says they have it.
 */
export function creditCurrencyWhere(currency: string, schoolCurrency: string): { currency: string } | { OR: Array<{ currency: string | null }> } {
  return currency === schoolCurrency ? { OR: [{ currency }, { currency: null }] } : { currency };
}

@Injectable()
export class PaymentPlansService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly paystack: PaystackService,
    private readonly region: SchoolRegionService,
    // LAST and @Optional deliberately. DI always provides it in the running
    // app; being optional keeps every existing unit wiring compiling, and
    // absent it FAILS OPEN — a missing switchboard must never be the reason a
    // parent cannot pay. It gates a commercial choice, not a security boundary.
    @Optional() private readonly channels?: PaymentChannelService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private async canSeeStudent(tx: TenantTx, p: Principal, studentId: string): Promise<boolean> {
    if (p.userId === studentId) return true;
    const link = await tx.parentChild.findFirst({ where: { parentId: p.userId, studentId }, select: { id: true } });
    if (link) return true;
    return p.roles.some((r) => STAFF_WIDE.includes(r));
  }

  /** Net paid — POSTED payments minus POSTED refunds. One definition, shared. */
  private paidMinor(tx: TenantTx, invoiceId: string): Promise<number> {
    return netPaidMinor(tx, invoiceId);
  }

  // ---------------------------------------------------------------------------
  // Installment plans
  // ---------------------------------------------------------------------------

  /** Staff replaces the invoice's plan wholesale. Tranches must sum EXACTLY to
   *  the invoice total — a plan that doesn't cover the bill is a trap. */
  async setPlan(
    p: Principal,
    invoiceId: string,
    tranches: Array<{ dueDate: string; amountMinor: number }>,
  ): Promise<PaymentPlanDto> {
    if (tranches.length < 1 || tranches.length > 24) throw new BadRequestException("1–24 tranches");
    const sorted = [...tranches].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const { guardians, reference } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { totalMinor: true, status: true, studentId: true, reference: true } });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status !== "ISSUED" && inv.status !== "PARTIALLY_PAID") {
        throw new BadRequestException("Plans apply to issued, unpaid invoices");
      }
      const sum = sorted.reduce((n, t) => n + t.amountMinor, 0);
      if (sum !== inv.totalMinor) {
        throw new BadRequestException("Tranches must sum exactly to the invoice total");
      }
      await tx.invoiceInstallment.deleteMany({ where: { invoiceId } });
      await tx.invoiceInstallment.createMany({
        data: sorted.map((t, i) => ({
          schoolId: p.schoolId,
          invoiceId,
          seq: i + 1,
          dueDate: new Date(t.dueDate),
          amountMinor: t.amountMinor,
        })),
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "fee.plan.set",
          entity: "invoice",
          entityId: invoiceId,
          schoolId: p.schoolId,
          metadata: { tranches: sorted.length },
        },
        tx,
      );
      // WHO to tell, inside; the telling itself, after. Each enqueue opens a
      // transaction of its own, so doing it here nested one transaction inside
      // another and announced a plan the outer transaction could still undo.
      return {
        guardians: (await tx.parentChild.findMany({
          where: { studentId: inv.studentId },
          select: { parentId: true },
        })) as Array<{ parentId: string }>,
        reference: inv.reference,
      };
    });
    for (const g of guardians) {
      try {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId: g.parentId,
          type: "BILLING",
          title: "Payment plan set",
          body: `Invoice ${reference} now has a ${sorted.length}-part payment plan (first part due ${sorted[0].dueDate}). Pay each part like any normal payment — partials count toward the schedule.`,
          data: { invoiceId },
          channels: ["EMAIL"],
        });
      } catch {
        // best-effort per guardian — the plan is set either way
      }
    }
    return this.getPlan(p, invoiceId);
  }

  /** Plan with DERIVED tranche states (cumulative paid vs cumulative due). */
  async getPlan(p: Principal, invoiceId: string): Promise<PaymentPlanDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { studentId: true } });
      if (!inv || !(await this.canSeeStudent(tx, p, inv.studentId))) throw new NotFoundException("Not found");
      const rows = await tx.invoiceInstallment.findMany({ where: { invoiceId }, orderBy: { seq: "asc" } });
      const paid = rows.length ? await this.paidMinor(tx, invoiceId) : 0;
      // WHAT THE BILL IS NOW, not what it was when the plan was written.
      //
      // `setPlan` checks the tranches sum exactly to the total, once. Three live
      // paths move an invoice afterwards — an approved DISCOUNT or WAIVER posts
      // a negative line item, the late-fee sweep and a library fine each append
      // a positive one — and nothing re-checked the plan.
      //
      // Measured live: a 100,000 invoice with a 50,000 + 50,000 plan, then an
      // approved 40,000 discount. The invoice went to 60,000, the family paid
      // 60,000, the invoice read PAID with a zero balance — and their plan said
      // instalment 2 of 50,000 was DUE.
      const total = (await tx.invoice.findFirst({ where: { id: invoiceId }, select: { totalMinor: true } }))?.totalMinor ?? 0;
      const plannedTotalMinor = rows.reduce((n: number, r: { amountMinor: number }) => n + r.amountMinor, 0);
      // The SCHOOL's calendar day, not the server's. A tranche due today is not
      // overdue, and comparing against UTC made it so from early evening in every
      // timezone west of it — a parent in Toronto saw OVERDUE on the due date.
      // Both sides are UTC-midnight Dates (`dueDate` is a @db.Date), so this is a
      // direct comparison rather than string slicing.
      const today = await this.region.todayInTx(tx, p.schoolId);
      let cumulative = 0;
      let firstUnpaidMarked = false;
      const tranches: InstallmentDto[] = rows.map((r: { seq: number; dueDate: Date; amountMinor: number }) => {
        cumulative += r.amountMinor;
        let state: InstallmentDto["state"];
        // CAPPED BY WHAT IS ACTUALLY OWED. A tranche asks for money by a date;
        // once the bill itself has fallen below the planned cumulative, the
        // remainder is not owed and must not read as outstanding. In the other
        // direction (a late fee appended after the plan) the cap does nothing —
        // deliberately: silently growing the last tranche would invent a
        // schedule the family never agreed to. That case is REPORTED instead,
        // via `coversInvoice`.
        const owedBy = Math.min(cumulative, total);
        if (paid >= owedBy) state = "PAID";
        else if (new Date(r.dueDate).getTime() < today.getTime()) {
          state = "OVERDUE";
          firstUnpaidMarked = true; // an overdue tranche IS the first unpaid one
        } else if (!firstUnpaidMarked) {
          state = "DUE";
          firstUnpaidMarked = true;
        } else state = "UPCOMING";
        return { seq: r.seq, dueDate: r.dueDate, amountMinor: r.amountMinor, state };
      });
      return {
        invoiceId,
        tranches,
        invoiceTotalMinor: total,
        plannedTotalMinor,
        coversInvoice: rows.length === 0 || plannedTotalMinor === total,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Credit ledger
  // ---------------------------------------------------------------------------

  async creditBalance(p: Principal, studentId: string): Promise<CreditBalanceDto> {
    const { currency } = await this.region.forSchool(p.schoolId);
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      if (!(await this.canSeeStudent(tx, p, studentId))) throw new NotFoundException("Not found");
      return this.balanceInTx(tx, studentId, currency);
    });
  }

  /**
   * The ledger, split by currency. `balanceMinor` stays the SCHOOL's-currency
   * balance, so a school that bills in one currency — nearly all of them — reads
   * exactly what it read before; `balances` is what a mixed-currency ledger
   * needs, and is the only figure a reader may put a currency symbol in front of.
   */
  private async balanceInTx(tx: TenantTx, studentId: string, schoolCurrency: string): Promise<CreditBalanceDto> {
    // Grouped in the DATABASE. One row per currency, not one per entry: this is
    // a sum, and hydrating a pupil's whole ledger to add it up in Node is the
    // habit `counting in Node` exists to name.
    const grouped = await tx.studentCreditEntry.groupBy({
      by: ["currency"],
      where: { studentId },
      _sum: { deltaMinor: true },
    });
    const byCurrency = new Map<string, number>();
    for (const g of grouped as Array<{ currency: string | null; _sum: { deltaMinor: number | null } }>) {
      const c = creditEntryCurrency(g.currency, schoolCurrency);
      byCurrency.set(c, (byCurrency.get(c) ?? 0) + (g._sum.deltaMinor ?? 0));
    }
    const entries = await tx.studentCreditEntry.findMany({
      where: { studentId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      studentId,
      currency: schoolCurrency,
      balanceMinor: byCurrency.get(schoolCurrency) ?? 0,
      // A ZERO bucket is still reported when it has rows, because "you have no
      // credit in dollars" and "there is no dollar ledger" are different answers
      // to a parent asking where their money went.
      balances: [...byCurrency.entries()]
        .map(([currency, balanceMinor]) => ({ currency, balanceMinor }))
        .sort((a, b) => (a.currency === schoolCurrency ? -1 : b.currency === schoolCurrency ? 1 : a.currency.localeCompare(b.currency))),
      entries: entries.map((e: { id: string; deltaMinor: number; currency: string | null; reason: string; reference: string | null; note: string | null; createdAt: Date }) => ({
        id: e.id,
        deltaMinor: e.deltaMinor,
        currency: creditEntryCurrency(e.currency, schoolCurrency),
        reason: e.reason,
        reference: e.reference,
        note: e.note,
        createdAt: e.createdAt,
      })),
    };
  }

  /** Parent/student starts a PREPAYMENT checkout (credited on webhook). */
  async initPrepay(p: Principal, studentId: string, amountMinor: number): Promise<{ authorizationUrl: string; reference: string }> {
    if (!this.paystack.isConfigured()) throw new ServiceUnavailableException("Online payments are not configured");
    const email = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (!(await this.canSeeStudent(tx, p, studentId))) throw new NotFoundException("Not found");
      const u = await tx.user.findFirst({ where: { id: p.userId }, select: { email: true } });
      return u?.email ?? "payer@school";
    });
    const reference = `PRE-${studentId.slice(0, 8)}-${Date.now()}`;
    // Prepayment becomes a student CREDIT in the school's own currency, so the
    // charge must be raised in it — crediting a ledger in one currency from a
    // charge in another is a balance that silently drifts.
    const { currency } = await this.region.forSchool(p.schoolId);
    await this.channels?.assertEnabled(PAYMENT_CHANNELS.PAYSTACK);
    const { authorizationUrl } = await this.paystack.initialize({
      email,
      amountMinor,
      currency,
      reference,
      metadata: { kind: "prepay", schoolId: p.schoolId, studentId, payerId: p.userId },
      callbackUrl: `${publicWebUrl()}/fees?prepaid=1`,
    });
    return { authorizationUrl, reference };
  }

  /** Webhook: a settled prepay charge credits the student's ledger. Idempotent
   *  on the gateway reference. */
  async applyPrepayment(event: PaystackEvent): Promise<{ ok: boolean }> {
    if (event.event !== "charge.success") return { ok: true };
    const { schoolId, studentId, payerId } = (event.data.metadata ?? {}) as {
      schoolId?: string;
      studentId?: string;
      payerId?: string;
    };
    if (!schoolId || !studentId) return { ok: true };
    const credited = await this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const already = await tx.studentCreditEntry.findFirst({
        where: { reference: event.data.reference },
        select: { id: true },
      });
      if (already) return false;
      await tx.studentCreditEntry.create({
        data: {
          schoolId,
          studentId,
          deltaMinor: event.data.amount,
          // From the SIGNED event — what the gateway says it charged, not what
          // `initPrepay` asked for. Same discipline as `applyOnlinePayment`:
          // a checkout opened before a region change comes back in the OLD
          // currency, and the entry must say so rather than inherit today's.
          currency: (event.data.currency ?? "").toUpperCase() || undefined,
          reason: "PREPAYMENT",
          reference: event.data.reference,
          note: "Online prepayment",
        },
      });
      return true;
    });
    if (credited) {
      // The EVENT's currency — this notice goes to the payer, who knows what
      // they were charged in.
      const amount = formatMoney(event.data.amount, event.data.currency ?? "NGN");
      for (const recipientId of [...new Set([studentId, ...(payerId ? [payerId] : [])])]) {
        try {
          await this.notifications.enqueue(
            { schoolId, userId: recipientId },
            {
              recipientId,
              type: "PAYMENT_RECEIVED",
              title: "Prepayment received",
              body: `${amount} was added to the student's fee credit balance (ref ${event.data.reference}). It will be applied to future invoices.`,
              data: { studentId, reference: event.data.reference },
              channels: ["EMAIL"],
            },
          );
        } catch {
          // best-effort per recipient
        }
      }
    }
    return { ok: true };
  }

  /** Webhook helper (dedicated-account transfers with no open invoice).
   *  `currency` is REQUIRED rather than defaulted: the caller had it in hand —
   *  it passes the same field to `applyOnlinePayment` two lines above, on the
   *  branch where an open invoice exists — and a required parameter is a search
   *  for every caller that was relying on a default. */
  async addCreditFromTransfer(
    schoolId: string,
    studentId: string,
    amountMinor: number,
    reference: string,
    currency: string,
  ): Promise<boolean> {
    return this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const already = await tx.studentCreditEntry.findFirst({ where: { reference }, select: { id: true } });
      if (already) return false;
      await tx.studentCreditEntry.create({
        data: { schoolId, studentId, deltaMinor: amountMinor, currency, reason: "PREPAYMENT", reference, note: "Bank transfer (dedicated account) — no open invoice" },
      });
      return true;
    });
  }

  /** Staff applies the student's credit balance to an open invoice: one
   *  APPLIED ledger entry + one CREDIT payment row, atomically. */
  async applyCreditToInvoice(p: Principal, invoiceId: string): Promise<{ appliedMinor: number }> {
    const { currency: schoolCurrency } = await this.region.forSchool(p.schoolId);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const inv = await tx.invoice.findFirst({
        where: { id: invoiceId },
        select: { studentId: true, totalMinor: true, status: true, reference: true, currency: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status !== "ISSUED" && inv.status !== "PARTIALLY_PAID") {
        throw new BadRequestException("Credit applies to issued, unpaid invoices");
      }
      const paid = await this.paidMinor(tx, invoiceId);
      const invoiceBalance = inv.totalMinor - paid;
      // ONLY credit in THIS INVOICE'S currency. Minor units of one currency are
      // not minor units of another and there is no FX rate in this platform —
      // inventing one to spend a balance would be worse than refusing, the same
      // decision `school.paymentApprovalThresholdMinor` records. A pupil can
      // legitimately hold both (a USD invoice overpaid, a naira bill open).
      const agg = await tx.studentCreditEntry.aggregate({
        where: { studentId: inv.studentId, ...creditCurrencyWhere(inv.currency, schoolCurrency) },
        _sum: { deltaMinor: true },
      });
      const credit = agg._sum.deltaMinor ?? 0;
      const apply = Math.min(invoiceBalance, credit);
      if (apply <= 0) {
        // Which of the two it is MATTERS to the person reading it: "none at all"
        // is the end of the matter, "none in dollars" is a balance they can see
        // on the pupil's other invoice and would otherwise report as a bug.
        const all = await tx.studentCreditEntry.aggregate({ where: { studentId: inv.studentId }, _sum: { deltaMinor: true } });
        throw new BadRequestException(
          (all._sum.deltaMinor ?? 0) > 0
            ? `No ${inv.currency} credit balance to apply — this pupil's credit is in another currency and cannot be converted`
            : "No credit balance to apply",
        );
      }
      await tx.studentCreditEntry.create({
        data: {
          schoolId: p.schoolId,
          studentId: inv.studentId,
          deltaMinor: -apply,
          currency: inv.currency,
          reason: "APPLIED",
          reference: invoiceId,
          note: `Applied to invoice ${inv.reference}`,
          createdById: p.userId,
        },
      });
      await tx.payment.create({
        data: {
          schoolId: p.schoolId,
          invoiceId,
          amountMinor: apply,
          method: "OTHER",
          kind: "CREDIT",
          status: "POSTED",
          note: "Credit balance applied",
          recordedById: p.userId,
        },
      });
      const newPaid = paid + apply;
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: newPaid >= inv.totalMinor ? "PAID" : "PARTIALLY_PAID" },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "fee.credit.apply",
          entity: "invoice",
          entityId: invoiceId,
          schoolId: p.schoolId,
          metadata: { appliedMinor: apply, currency: inv.currency },
        },
        tx,
      );
      return { appliedMinor: apply };
    });
  }

  /** Staff moves an invoice's overpaid excess to the student's credit balance:
   *  a POSTED system REFUND on the invoice + an OVERPAYMENT entry (double-
   *  entry, so collections never count the excess twice). */
  async moveOverpaymentToCredit(p: Principal, invoiceId: string): Promise<{ movedMinor: number }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const inv = await tx.invoice.findFirst({
        where: { id: invoiceId },
        select: { studentId: true, totalMinor: true, reference: true, currency: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      const paid = await this.paidMinor(tx, invoiceId);
      const excess = paid - inv.totalMinor;
      if (excess <= 0) throw new BadRequestException("Invoice is not overpaid");
      await tx.payment.create({
        data: {
          schoolId: p.schoolId,
          invoiceId,
          amountMinor: excess,
          method: "OTHER",
          kind: "REFUND",
          status: "POSTED",
          note: "Overpayment moved to credit balance",
          recordedById: p.userId,
        },
      });
      await tx.studentCreditEntry.create({
        data: {
          schoolId: p.schoolId,
          studentId: inv.studentId,
          deltaMinor: excess,
          // The excess is money paid against THIS invoice, so it is in THIS
          // invoice's currency — not the school's, which may be a different one.
          currency: inv.currency,
          reason: "OVERPAYMENT",
          reference: invoiceId,
          note: `Moved from invoice ${inv.reference}`,
          createdById: p.userId,
        },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "fee.credit.from_overpayment",
          entity: "invoice",
          entityId: invoiceId,
          schoolId: p.schoolId,
          metadata: { movedMinor: excess, currency: inv.currency },
        },
        tx,
      );
      return { movedMinor: excess };
    });
  }
}
