// =============================================================================
// FeeOpsService — adjustments (maker-checker), late fees, sweeps, exports
// =============================================================================
// The operational finish on fee collection:
//   ADJUSTMENTS — a discount/waiver is a formal, approvable record, not an
//   invisible line-item edit: requested by fee.manage, approved by a DIFFERENT
//   fee.approve holder (separation of duties, same rule as payment approval);
//   approval posts a NEGATIVE line item and reduces the total (never below
//   what is already paid). History is permanent (rls/82).
//   LATE FEES — per-school config on the registry (lateFeeFlatMinor /
//   lateFeeGraceDays, privileged write like the other fee columns). The daily
//   sweep adds the fee ONCE per overdue invoice (idempotent via the marker
//   line item), raises the total, and notifies guardians.
//   REMINDER SWEEP — the staff-triggered reminder now also runs WEEKLY per
//   school (overdue-only, so the automated path never nags before due date).
//   Both sweeps are cross-tenant drivers over the PRIVILEGED school list with
//   all writes through the ordinary tenant path (RLS intact) — dunning's
//   pattern exactly.
//   RECEIPT PDF — GET /payments/:id/receipt.pdf renders a numbered receipt
//   on demand (pdfkit, payslip-PDF precedent), relationship-scoped + audited.
//   JOURNAL EXPORT — GET /fees/export/journal.csv: every POSTED payment in a
//   date range as formula-guarded CSV for the school's accountant.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import PDFDocument from "pdfkit";
import type { InvoiceAdjustmentDto, LateFeeConfigDto } from "@sms/types";
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
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { FeesService } from "./fees.service";

export const FEE_OPS_QUEUE = "fee-ops";
export const LATE_FEE_JOB = "fee-late-fee-sweep";
export const REMINDER_JOB = "fee-reminder-sweep";
export const LATE_FEE_SCHEDULER_ID = "fee-late-fee-daily";
export const REMINDER_SCHEDULER_ID = "fee-reminder-weekly";
/** 05:20 daily (late fees) / 06:00 Mondays (reminders). Env-overridable. */
export const DEFAULT_LATE_FEE_CRON = "20 5 * * *";
export const DEFAULT_REMINDER_CRON = "0 6 * * 1";
/** Marker prefix that makes the late-fee line item idempotent per invoice. */
const LATE_FEE_MARKER = "Late payment fee";

type AdjustmentRow = {
  id: string;
  invoiceId: string;
  kind: string;
  amountMinor: number;
  reason: string;
  status: string;
  requestedById: string;
  approvedById: string | null;
  createdAt: Date;
};

@Injectable()
export class FeeOpsService {
  private readonly logger = new Logger("FeeOps");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly fees: FeesService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private toAdjustmentDto(a: AdjustmentRow): InvoiceAdjustmentDto {
    return {
      id: a.id,
      invoiceId: a.invoiceId,
      kind: a.kind as InvoiceAdjustmentDto["kind"],
      amountMinor: a.amountMinor,
      reason: a.reason,
      status: a.status as InvoiceAdjustmentDto["status"],
      requestedById: a.requestedById,
      approvedById: a.approvedById,
      createdAt: a.createdAt,
    };
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
  // Adjustments (discount / waiver) — maker-checker
  // ---------------------------------------------------------------------------

  async requestAdjustment(
    p: Principal,
    invoiceId: string,
    input: { kind: "DISCOUNT" | "WAIVER"; amountMinor: number; reason: string },
  ): Promise<InvoiceAdjustmentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { status: true, totalMinor: true } });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status !== "ISSUED" && inv.status !== "PARTIALLY_PAID") {
        throw new BadRequestException("Adjustments apply to issued, unpaid invoices");
      }
      const paid = await this.paidMinor(tx, invoiceId);
      if (input.amountMinor > inv.totalMinor - paid) {
        throw new BadRequestException("Adjustment exceeds the outstanding balance");
      }
      const row = await tx.invoiceAdjustment.create({
        data: {
          schoolId: p.schoolId,
          invoiceId,
          kind: input.kind,
          amountMinor: input.amountMinor,
          reason: input.reason,
          requestedById: p.userId,
        },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "fee.adjustment.request",
          entity: "invoice_adjustment",
          entityId: row.id,
          schoolId: p.schoolId,
          metadata: { invoiceId, kind: input.kind, amountMinor: input.amountMinor },
        },
        tx,
      );
      return this.toAdjustmentDto(row);
    });
  }

  /** Approver must hold fee.approve AND differ from the requester. Approval
   *  posts the negative line item + reduces the total, atomically. */
  async decideAdjustment(p: Principal, adjustmentId: string, approve: boolean): Promise<InvoiceAdjustmentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.invoiceAdjustment.findFirst({ where: { id: adjustmentId } });
      if (!row) throw new NotFoundException("Adjustment not found");
      if (row.status !== "PENDING_APPROVAL") throw new BadRequestException("Already decided");
      // SECURITY: separation of duties — the requester can never approve their
      // own discount (same rule as payment maker-checker).
      if (row.requestedById === p.userId) {
        throw new ForbiddenException("A different staff member must decide this adjustment");
      }
      if (!approve) {
        const updated = await tx.invoiceAdjustment.update({
          where: { id: adjustmentId },
          data: { status: "REJECTED", approvedById: p.userId },
        });
        await this.audit.record(
          { actorId: p.userId, action: "fee.adjustment.reject", entity: "invoice_adjustment", entityId: adjustmentId, schoolId: p.schoolId },
          tx,
        );
        return this.toAdjustmentDto(updated);
      }
      const inv = await tx.invoice.findFirst({
        where: { id: row.invoiceId },
        select: { totalMinor: true, studentId: true, reference: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      const paid = await this.paidMinor(tx, row.invoiceId);
      if (row.amountMinor > inv.totalMinor - paid) {
        throw new BadRequestException("Adjustment now exceeds the outstanding balance");
      }
      await tx.invoiceLineItem.create({
        data: {
          schoolId: p.schoolId,
          invoiceId: row.invoiceId,
          description: `${row.kind === "WAIVER" ? "Waiver" : "Discount"}: ${row.reason}`,
          amountMinor: -row.amountMinor,
          quantity: 1,
        },
      });
      const newTotal = inv.totalMinor - row.amountMinor;
      await tx.invoice.update({
        where: { id: row.invoiceId },
        data: { totalMinor: newTotal, status: paid >= newTotal ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "ISSUED" },
      });
      const updated = await tx.invoiceAdjustment.update({
        where: { id: adjustmentId },
        data: { status: "APPROVED", approvedById: p.userId },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "fee.adjustment.approve",
          entity: "invoice_adjustment",
          entityId: adjustmentId,
          schoolId: p.schoolId,
          metadata: { invoiceId: row.invoiceId, amountMinor: row.amountMinor },
        },
        tx,
      );
      const guardians = await tx.parentChild.findMany({ where: { studentId: inv.studentId }, select: { parentId: true } });
      for (const g of guardians) {
        try {
          await this.notifications.enqueue(this.ctx(p), {
            recipientId: g.parentId,
            type: "BILLING",
            title: `${row.kind === "WAIVER" ? "Fee waiver" : "Discount"} applied`,
            body: `Invoice ${inv.reference} was reduced by ${(row.amountMinor / 100).toFixed(2)} (${row.reason}).`,
            data: { invoiceId: row.invoiceId },
            channels: ["EMAIL"],
          });
        } catch {
          // best-effort per guardian
        }
      }
      return this.toAdjustmentDto(updated);
    });
  }

  async listAdjustments(p: Principal, invoiceId: string): Promise<InvoiceAdjustmentDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { id: true } });
      if (!inv) throw new NotFoundException("Invoice not found");
      const rows = await tx.invoiceAdjustment.findMany({ where: { invoiceId }, orderBy: { createdAt: "desc" } });
      return rows.map((r: AdjustmentRow) => this.toAdjustmentDto(r));
    });
  }

  // ---------------------------------------------------------------------------
  // Late-fee config (school registry — privileged write, like fee bearer)
  // ---------------------------------------------------------------------------

  async getLateFeeConfig(p: Principal): Promise<LateFeeConfigDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const school = await tx.school.findFirst({
        where: { id: p.schoolId },
        select: { lateFeeFlatMinor: true, lateFeeGraceDays: true },
      });
      return { lateFeeFlatMinor: school?.lateFeeFlatMinor ?? 0, lateFeeGraceDays: school?.lateFeeGraceDays ?? 7 };
    });
  }

  async setLateFeeConfig(p: Principal, input: LateFeeConfigDto): Promise<LateFeeConfigDto> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Late-fee configuration requires the privileged database configuration");
    await client.school.update({
      where: { id: p.schoolId },
      data: { lateFeeFlatMinor: input.lateFeeFlatMinor, lateFeeGraceDays: input.lateFeeGraceDays },
    });
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "fee.late_fee.config",
          entity: "school",
          entityId: p.schoolId,
          schoolId: p.schoolId,
          metadata: { ...input },
        },
        tx,
      ),
    );
    return this.getLateFeeConfig(p);
  }

  // ---------------------------------------------------------------------------
  // Sweeps (cross-tenant drivers — privileged school list, tenant-scoped writes)
  // ---------------------------------------------------------------------------

  /** Add the configured flat late fee ONCE to each invoice overdue past grace.
   *  Idempotent: the marker line item is the "already applied" flag. */
  async lateFeeSweep(): Promise<{ schools: number; feesApplied: number }> {
    const client = this.privileged.client;
    if (!client) return { schools: 0, feesApplied: 0 };
    const schools = await client.school.findMany({
      where: { isPlatform: false, lateFeeFlatMinor: { gt: 0 } },
      select: { id: true, lateFeeFlatMinor: true, lateFeeGraceDays: true },
    });
    let feesApplied = 0;
    for (const school of schools) {
      const cutoff = new Date(Date.now() - school.lateFeeGraceDays * 86_400_000);
      try {
        feesApplied += await this.db.runAsTenant({ schoolId: school.id, userId: SYSTEM_ACTOR_ID }, async (tx) => {
          const overdue = await tx.invoice.findMany({
            where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] }, dueDate: { lt: cutoff } },
            select: { id: true, totalMinor: true, studentId: true, reference: true, createdById: true },
            take: 500,
          });
          let applied = 0;
          for (const inv of overdue) {
            const marker = await tx.invoiceLineItem.findFirst({
              where: { invoiceId: inv.id, description: { startsWith: LATE_FEE_MARKER } },
              select: { id: true },
            });
            if (marker) continue; // once per invoice, ever
            await tx.invoiceLineItem.create({
              data: {
                schoolId: school.id,
                invoiceId: inv.id,
                description: `${LATE_FEE_MARKER} (overdue past ${school.lateFeeGraceDays} days)`,
                amountMinor: school.lateFeeFlatMinor,
                quantity: 1,
              },
            });
            await tx.invoice.update({
              where: { id: inv.id },
              data: { totalMinor: inv.totalMinor + school.lateFeeFlatMinor },
            });
            await this.audit.record(
              {
                actorId: inv.createdById,
                action: "fee.late_fee.apply",
                entity: "invoice",
                entityId: inv.id,
                schoolId: school.id,
                metadata: { lateFeeMinor: school.lateFeeFlatMinor },
              },
              tx,
            );
            const guardians = await tx.parentChild.findMany({
              where: { studentId: inv.studentId },
              select: { parentId: true },
            });
            for (const g of guardians) {
              try {
                await this.notifications.enqueue(
                  { schoolId: school.id, userId: g.parentId },
                  {
                    recipientId: g.parentId,
                    type: "BILLING",
                    title: "Late fee added",
                    body: `Invoice ${inv.reference} was overdue past the grace period; a late fee of ${(school.lateFeeFlatMinor / 100).toFixed(2)} was added. Settle the balance to avoid further action.`,
                    data: { invoiceId: inv.id },
                    channels: ["EMAIL"],
                  },
                );
              } catch {
                // best-effort per guardian
              }
            }
            applied++;
          }
          return applied;
        });
      } catch (e) {
        this.logger.warn(`late-fee sweep failed for school ${school.id}: ${(e as Error).message}`);
      }
    }
    return { schools: schools.length, feesApplied };
  }

  /** Weekly overdue-reminder sweep: the staff-triggered reminder, run for every
   *  school under a SYSTEM principal (overdue-only — never nags early). */
  async reminderSweep(): Promise<{ schools: number; reminded: number }> {
    const client = this.privileged.client;
    if (!client) return { schools: 0, reminded: 0 };
    const schools = await client.school.findMany({ where: { isPlatform: false }, select: { id: true } });
    let reminded = 0;
    for (const school of schools) {
      try {
        const system: Principal = { userId: SYSTEM_ACTOR_ID, schoolId: school.id, roles: [], permissions: [] };
        const r = await this.fees.sendFeeReminders(system, { overdueOnly: true });
        reminded += r.reminded;
      } catch (e) {
        this.logger.warn(`reminder sweep failed for school ${school.id}: ${(e as Error).message}`);
      }
    }
    return { schools: schools.length, reminded };
  }

  // ---------------------------------------------------------------------------
  // Receipt PDF (on demand) + journal export
  // ---------------------------------------------------------------------------

  /** Numbered receipt for a POSTED payment — payer/guardian/student/staff
   *  scoped (404-not-403), audited like every financial read that leaves. */
  async receiptPdf(p: Principal, paymentId: string): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const pay = await tx.payment.findFirst({
        where: { id: paymentId, status: "POSTED" },
        include: { invoice: { select: { reference: true, studentId: true, currency: true, totalMinor: true } } },
      });
      if (!pay) throw new NotFoundException("Payment not found");
      const studentId = pay.invoice.studentId;
      const isStaff = p.roles.some((r) => ["accountant", "school_admin", "principal", "super_admin"].includes(r));
      const isFamily =
        p.userId === studentId ||
        !!(await tx.parentChild.findFirst({ where: { parentId: p.userId, studentId }, select: { id: true } }));
      if (!isStaff && !isFamily) throw new NotFoundException("Payment not found"); // 404-not-403
      const student = await tx.user.findFirst({ where: { id: studentId }, select: { name: true } });
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true } });
      const paid = await this.paidMinor(tx, pay.invoiceId);
      await this.audit.record(
        { actorId: p.userId, action: "fee.receipt.download", entity: "payment", entityId: paymentId, schoolId: p.schoolId },
        tx,
      );
      return {
        pay,
        studentName: student?.name ?? "Student",
        schoolName: school?.name ?? "",
        balanceMinor: pay.invoice.totalMinor - paid,
      };
    });

    const receiptNo = `RCP-${data.pay.createdAt.toISOString().slice(0, 10).replace(/-/g, "")}-${paymentId.slice(0, 8).toUpperCase()}`;
    const money = (minor: number) => `${data.pay.invoice.currency} ${(minor / 100).toFixed(2)}`;
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: "A5", margin: 40 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.fontSize(16).text(data.schoolName, { align: "center" });
      doc.moveDown(0.3).fontSize(12).text("OFFICIAL RECEIPT", { align: "center" });
      doc.moveDown();
      doc.fontSize(10);
      doc.text(`Receipt no: ${receiptNo}`);
      doc.text(`Date: ${data.pay.paidAt.toISOString().slice(0, 10)}`);
      doc.text(`Student: ${data.studentName}`);
      doc.text(`Invoice: ${data.pay.invoice.reference}`);
      doc.moveDown();
      doc.fontSize(12).text(`${data.pay.kind === "REFUND" ? "Refund" : "Amount received"}: ${money(data.pay.amountMinor)}`);
      doc.fontSize(10).text(`Method: ${data.pay.method}${data.pay.reference ? ` · ref ${data.pay.reference}` : ""}`);
      doc.moveDown();
      doc.text(
        data.balanceMinor <= 0 ? "Invoice fully settled." : `Outstanding balance: ${money(data.balanceMinor)}`,
      );
      doc.moveDown(2).fontSize(8).fillColor("#666").text("Computer-generated receipt — valid without signature.", { align: "center" });
      doc.end();
    });
    return { buffer, filename: `${receiptNo}.pdf` };
  }

  /** Every POSTED payment in [from,to] as formula-guarded CSV (fee.manage). */
  async journalCsv(p: Principal, from: string, to: string): Promise<{ csv: string; filename: string }> {
    const rows = await this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const pays = await tx.payment.findMany({
        where: { status: "POSTED", paidAt: { gte: new Date(from), lte: new Date(`${to}T23:59:59.999Z`) } },
        include: { invoice: { select: { reference: true, studentId: true, currency: true } } },
        orderBy: { paidAt: "asc" },
        take: 10_000,
      });
      const studentIds = [...new Set(pays.map((x: { invoice: { studentId: string } }) => x.invoice.studentId))];
      const students = studentIds.length
        ? await tx.user.findMany({ where: { id: { in: studentIds as string[] } }, select: { id: true, name: true } })
        : [];
      const nameOf = new Map(students.map((s: { id: string; name: string }) => [s.id, s.name]));
      return pays.map(
        (x: {
          id: string;
          paidAt: Date;
          amountMinor: number;
          kind: string;
          method: string;
          reference: string | null;
          invoice: { reference: string; studentId: string; currency: string };
        }) => ({
          date: x.paidAt.toISOString().slice(0, 10),
          receipt: `RCP-${x.paidAt.toISOString().slice(0, 10).replace(/-/g, "")}-${x.id.slice(0, 8).toUpperCase()}`,
          invoice: x.invoice.reference,
          student: nameOf.get(x.invoice.studentId) ?? x.invoice.studentId,
          method: x.method,
          kind: x.kind,
          currency: x.invoice.currency,
          // Signed major-unit amount: refunds negative — a ready journal column.
          amount: ((x.kind === "REFUND" ? -x.amountMinor : x.amountMinor) / 100).toFixed(2),
          gatewayRef: x.reference ?? "",
        }),
      );
    });
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "fee.journal.export",
          entity: "school",
          entityId: p.schoolId,
          schoolId: p.schoolId,
          metadata: { from, to, rows: rows.length },
        },
        tx,
      ),
    );
    const header = ["Date", "Receipt", "Invoice", "Student", "Method", "Kind", "Currency", "Amount", "GatewayRef"];
    const lines = [header.map(csvCell).join(",")];
    for (const r of rows) {
      lines.push(
        [r.date, r.receipt, r.invoice, r.student, r.method, r.kind, r.currency, r.amount, r.gatewayRef]
          .map(csvCell)
          .join(","),
      );
    }
    return { csv: lines.join("\r\n") + "\r\n", filename: `fee-journal-${from}-to-${to}.csv` };
  }
}

/** RFC-4180 CSV escaping + formula-injection defence (OWASP; mirrors the
 *  platform-audit exporter). */
function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
