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
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { CreditBalanceDto, InstallmentDto, PaymentPlanDto } from "@sms/types";
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
import { NotificationService } from "../notifications/notification.service";
import { PaystackService, type PaystackEvent } from "../payments/paystack.service";

const STAFF_WIDE = ["accountant", "school_admin", "principal", "super_admin"];

@Injectable()
export class PaymentPlansService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly paystack: PaystackService,
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

  private async paidMinor(tx: TenantTx, invoiceId: string): Promise<number> {
    const posted = await tx.payment.findMany({
      where: { invoiceId, status: "POSTED" },
      select: { amountMinor: true, kind: true },
    });
    return posted.reduce(
      (n: number, x: { amountMinor: number; kind: string }) => n + (x.kind === "REFUND" ? -x.amountMinor : x.amountMinor),
      0,
    );
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
    await this.db.runAsTenant(this.ctx(p), async (tx) => {
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
      const guardians = await tx.parentChild.findMany({ where: { studentId: inv.studentId }, select: { parentId: true } });
      for (const g of guardians) {
        try {
          await this.notifications.enqueue(this.ctx(p), {
            recipientId: g.parentId,
            type: "BILLING",
            title: "Payment plan set",
            body: `Invoice ${inv.reference} now has a ${sorted.length}-part payment plan (first part due ${sorted[0].dueDate}). Pay each part like any normal payment — partials count toward the schedule.`,
            data: { invoiceId },
            channels: ["EMAIL"],
          });
        } catch {
          // best-effort per guardian
        }
      }
    });
    return this.getPlan(p, invoiceId);
  }

  /** Plan with DERIVED tranche states (cumulative paid vs cumulative due). */
  async getPlan(p: Principal, invoiceId: string): Promise<PaymentPlanDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { studentId: true } });
      if (!inv || !(await this.canSeeStudent(tx, p, inv.studentId))) throw new NotFoundException("Not found");
      const rows = await tx.invoiceInstallment.findMany({ where: { invoiceId }, orderBy: { seq: "asc" } });
      const paid = rows.length ? await this.paidMinor(tx, invoiceId) : 0;
      const today = new Date().toISOString().slice(0, 10);
      let cumulative = 0;
      let firstUnpaidMarked = false;
      const tranches: InstallmentDto[] = rows.map((r: { seq: number; dueDate: Date; amountMinor: number }) => {
        cumulative += r.amountMinor;
        let state: InstallmentDto["state"];
        if (paid >= cumulative) state = "PAID";
        else if (new Date(r.dueDate).toISOString().slice(0, 10) < today) {
          state = "OVERDUE";
          firstUnpaidMarked = true; // an overdue tranche IS the first unpaid one
        } else if (!firstUnpaidMarked) {
          state = "DUE";
          firstUnpaidMarked = true;
        } else state = "UPCOMING";
        return { seq: r.seq, dueDate: r.dueDate, amountMinor: r.amountMinor, state };
      });
      return { invoiceId, tranches };
    });
  }

  // ---------------------------------------------------------------------------
  // Credit ledger
  // ---------------------------------------------------------------------------

  async creditBalance(p: Principal, studentId: string): Promise<CreditBalanceDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      if (!(await this.canSeeStudent(tx, p, studentId))) throw new NotFoundException("Not found");
      return this.balanceInTx(tx, studentId);
    });
  }

  private async balanceInTx(tx: TenantTx, studentId: string): Promise<CreditBalanceDto> {
    const agg = await tx.studentCreditEntry.aggregate({ where: { studentId }, _sum: { deltaMinor: true } });
    const entries = await tx.studentCreditEntry.findMany({
      where: { studentId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      studentId,
      balanceMinor: agg._sum.deltaMinor ?? 0,
      entries: entries.map((e: { id: string; deltaMinor: number; reason: string; reference: string | null; note: string | null; createdAt: Date }) => ({
        id: e.id,
        deltaMinor: e.deltaMinor,
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
    const { authorizationUrl } = await this.paystack.initialize({
      email,
      amountMinor,
      reference,
      metadata: { kind: "prepay", schoolId: p.schoolId, studentId, payerId: p.userId },
      callbackUrl: `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"}/fees?prepaid=1`,
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
          reason: "PREPAYMENT",
          reference: event.data.reference,
          note: "Online prepayment",
        },
      });
      return true;
    });
    if (credited) {
      const amount = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" }).format(event.data.amount / 100);
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

  /** Webhook helper (dedicated-account transfers with no open invoice). */
  async addCreditFromTransfer(schoolId: string, studentId: string, amountMinor: number, reference: string): Promise<boolean> {
    return this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const already = await tx.studentCreditEntry.findFirst({ where: { reference }, select: { id: true } });
      if (already) return false;
      await tx.studentCreditEntry.create({
        data: { schoolId, studentId, deltaMinor: amountMinor, reason: "PREPAYMENT", reference, note: "Bank transfer (dedicated account) — no open invoice" },
      });
      return true;
    });
  }

  /** Staff applies the student's credit balance to an open invoice: one
   *  APPLIED ledger entry + one CREDIT payment row, atomically. */
  async applyCreditToInvoice(p: Principal, invoiceId: string): Promise<{ appliedMinor: number }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const inv = await tx.invoice.findFirst({
        where: { id: invoiceId },
        select: { studentId: true, totalMinor: true, status: true, reference: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status !== "ISSUED" && inv.status !== "PARTIALLY_PAID") {
        throw new BadRequestException("Credit applies to issued, unpaid invoices");
      }
      const paid = await this.paidMinor(tx, invoiceId);
      const invoiceBalance = inv.totalMinor - paid;
      const agg = await tx.studentCreditEntry.aggregate({ where: { studentId: inv.studentId }, _sum: { deltaMinor: true } });
      const credit = agg._sum.deltaMinor ?? 0;
      const apply = Math.min(invoiceBalance, credit);
      if (apply <= 0) throw new BadRequestException("No credit balance to apply");
      await tx.studentCreditEntry.create({
        data: {
          schoolId: p.schoolId,
          studentId: inv.studentId,
          deltaMinor: -apply,
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
          metadata: { appliedMinor: apply },
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
        select: { studentId: true, totalMinor: true, reference: true },
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
          metadata: { movedMinor: excess },
        },
        tx,
      );
      return { movedMinor: excess };
    });
  }
}
