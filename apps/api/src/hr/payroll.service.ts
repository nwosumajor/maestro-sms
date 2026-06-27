// =============================================================================
// PayrollService — monthly payroll runs + payslips
// =============================================================================
// A run SNAPSHOTS every active employee's current (decrypted) salary into a
// payslip for the period, computes totals, and persists DRAFT. Per-employee
// amounts are stored field-ENCRYPTED at rest (per-tenant key); run totals are
// aggregate minor units. Finalizing locks the run. One run per (school, year,
// month). Tenant-isolated (RLS); access gated by hr.payroll.run / hr.read.
// =============================================================================

import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import PDFDocument from "pdfkit";
import { computeMonthlyPayslip, type PayrollRunDto, type PayslipDto } from "@sms/types";
import { decryptField, encryptField } from "../foundation/field-crypto";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

@Injectable()
export class PayrollService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Generate a DRAFT run from active employees' current salaries. */
  async createRun(p: Principal, periodYear: number, periodMonth: number): Promise<PayrollRunDto> {
    if (periodMonth < 1 || periodMonth > 12) throw new BadRequestException("month must be 1–12");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const dup = await tx.payrollRun.findFirst({ where: { periodYear, periodMonth } });
      if (dup) throw new ConflictException("A payroll run already exists for that period");

      const employees = await tx.employee.findMany({ where: { status: "ACTIVE" } });
      let totalGross = 0;
      let totalNet = 0;
      const run = await tx.payrollRun.create({
        data: { schoolId: p.schoolId, periodYear, periodMonth, status: "DRAFT", runById: p.userId },
      });
      for (const e of employees) {
        const gross = e.salaryEnc ? Number(decryptField(e.salaryEnc, p.schoolId)) : 0;
        // Statutory deductions: PAYE (PIT bands) + 8% pension — pure, see @sms/types.
        const { deductionsMinor, netMinor } = computeMonthlyPayslip(gross);
        totalGross += gross;
        totalNet += netMinor;
        await tx.payslip.create({
          data: {
            schoolId: p.schoolId,
            payrollRunId: run.id,
            userId: e.userId,
            grossEnc: encryptField(String(gross), p.schoolId),
            deductionsEnc: encryptField(String(deductionsMinor), p.schoolId),
            netEnc: encryptField(String(netMinor), p.schoolId),
          },
        });
      }
      const updated = await tx.payrollRun.update({
        where: { id: run.id },
        data: { totalGrossMinor: totalGross, totalNetMinor: totalNet },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.payroll.run.create", entity: "payroll_run", entityId: run.id, schoolId: p.schoolId, metadata: { periodYear, periodMonth, employees: employees.length } },
        tx,
      );
      return this.decorateRun(updated, employees.length, undefined);
    });
  }

  async listRuns(p: Principal): Promise<PayrollRunDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const runs = await tx.payrollRun.findMany({ orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }] });
      const out: PayrollRunDto[] = [];
      for (const r of runs) {
        const count = await tx.payslip.count({ where: { payrollRunId: r.id } });
        out.push(this.decorateRun(r, count, undefined));
      }
      return out;
    });
  }

  async getRun(p: Principal, id: string): Promise<PayrollRunDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const run = await tx.payrollRun.findFirst({ where: { id } });
      if (!run) throw new NotFoundException("Payroll run not found");
      const slips = await tx.payslip.findMany({ where: { payrollRunId: id } });
      const users = await tx.user.findMany({ where: { id: { in: slips.map((s) => s.userId) } }, select: { id: true, name: true } });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      const payslips: PayslipDto[] = slips.map((s) => ({
        id: s.id,
        userId: s.userId,
        userName: nameById.get(s.userId) ?? null,
        grossMinor: s.grossEnc ? Number(decryptField(s.grossEnc, p.schoolId)) : null,
        deductionsMinor: s.deductionsEnc ? Number(decryptField(s.deductionsEnc, p.schoolId)) : null,
        netMinor: s.netEnc ? Number(decryptField(s.netEnc, p.schoolId)) : null,
      }));
      await this.audit.record(
        { actorId: p.userId, action: "hr.payroll.run.read", entity: "payroll_run", entityId: id, schoolId: p.schoolId },
        tx,
      );
      return this.decorateRun(run, slips.length, payslips);
    });
  }

  async finalizeRun(p: Principal, id: string): Promise<PayrollRunDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const run = await tx.payrollRun.findFirst({ where: { id } });
      if (!run) throw new NotFoundException("Payroll run not found");
      if (run.status === "FINALIZED") throw new BadRequestException("Run already finalized");
      // Maker-checker: the person who generated the run cannot finalize it.
      if (run.runById === p.userId) {
        throw new ForbiddenException("Payroll must be finalized by a different person");
      }
      const updated = await tx.payrollRun.update({
        where: { id },
        data: { status: "FINALIZED", finalizedById: p.userId, finalizedAt: new Date() },
      });
      const count = await tx.payslip.count({ where: { payrollRunId: id } });
      await this.audit.record(
        { actorId: p.userId, action: "hr.payroll.run.finalize", entity: "payroll_run", entityId: id, schoolId: p.schoolId },
        tx,
      );
      return this.decorateRun(updated, count, undefined);
    });
  }

  /** Bank-transfer export (CSV) for a run: name, bank, account, net pay. */
  async bankExport(p: Principal, runId: string): Promise<{ csv: string; filename: string }> {
    const rows = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const run = await tx.payrollRun.findFirst({ where: { id: runId } });
      if (!run) throw new NotFoundException("Payroll run not found");
      const slips = await tx.payslip.findMany({ where: { payrollRunId: runId } });
      const userIds = slips.map((s) => s.userId);
      const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
      const emps = await tx.employee.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, bankNameEnc: true, bankAccountEnc: true },
      });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      const empByUser = new Map(emps.map((e) => [e.userId, e]));
      await this.audit.record(
        { actorId: p.userId, action: "hr.payroll.bank.export", entity: "payroll_run", entityId: runId, schoolId: p.schoolId },
        tx,
      );
      return { run, slips, nameById, empByUser };
    });
    const dec = (v: string | null | undefined) => (v ? decryptField(v, p.schoolId) : "");
    const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = ['"Employee","Bank","Account","Net (NGN)"'];
    for (const s of rows.slips) {
      const emp = rows.empByUser.get(s.userId);
      const net = s.netEnc ? Number(decryptField(s.netEnc, p.schoolId)) / 100 : 0;
      lines.push([
        esc(rows.nameById.get(s.userId) ?? ""),
        esc(dec(emp?.bankNameEnc)),
        esc(dec(emp?.bankAccountEnc)),
        net.toFixed(2),
      ].join(","));
    }
    return {
      csv: lines.join("\n") + "\n",
      filename: `bank-export-${rows.run.periodYear}-${String(rows.run.periodMonth).padStart(2, "0")}.csv`,
    };
  }

  /** Render one employee's payslip for a run as a PDF (amounts decrypted in-memory). */
  async payslipPdf(p: Principal, runId: string, userId: string): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const run = await tx.payrollRun.findFirst({ where: { id: runId } });
      if (!run) throw new NotFoundException("Payroll run not found");
      const slip = await tx.payslip.findFirst({ where: { payrollRunId: runId, userId } });
      if (!slip) throw new NotFoundException("Payslip not found");
      const user = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true } });
      const gross = slip.grossEnc ? Number(decryptField(slip.grossEnc, p.schoolId)) : 0;
      await this.audit.record(
        { actorId: p.userId, action: "hr.payroll.payslip.read", entity: "payslip", entityId: slip.id, schoolId: p.schoolId, metadata: { userId } },
        tx,
      );
      return { run, name: user?.name ?? "Staff", school: school?.name ?? "School", gross };
    });
    const bd = computeMonthlyPayslip(data.gross);
    const naira = (m: number) => `NGN ${(m / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.fontSize(18).text(data.school, { align: "left" });
      doc.moveDown(0.3).fontSize(13).text(`Payslip — ${data.run.periodMonth}/${data.run.periodYear}`);
      doc.moveDown(0.5).fontSize(11).text(`Employee: ${data.name}`);
      doc.moveDown(1);
      const line = (label: string, val: string) => doc.fontSize(11).text(label, { continued: true }).text(val, { align: "right" });
      line("Gross pay", naira(bd.grossMinor));
      line("PAYE (income tax)", `- ${naira(bd.payeMinor)}`);
      line("Pension (8%)", `- ${naira(bd.pensionMinor)}`);
      doc.moveDown(0.3);
      doc.fontSize(12).text("Net pay", { continued: true }).text(naira(bd.netMinor), { align: "right" });
      doc.moveDown(2).fontSize(8).fillColor("#666").text("Generated by the School Management System. Figures in NGN.");
      doc.end();
    });
    return { buffer, filename: `payslip-${data.run.periodYear}-${String(data.run.periodMonth).padStart(2, "0")}-${userId.slice(0, 8)}.pdf` };
  }

  private decorateRun(
    r: { id: string; periodYear: number; periodMonth: number; status: string; totalGrossMinor: number; totalNetMinor: number; createdAt: Date; finalizedAt: Date | null },
    payslipCount: number,
    payslips: PayslipDto[] | undefined,
  ): PayrollRunDto {
    return {
      id: r.id,
      periodYear: r.periodYear,
      periodMonth: r.periodMonth,
      status: r.status,
      totalGrossMinor: r.totalGrossMinor,
      totalNetMinor: r.totalNetMinor,
      payslipCount,
      createdAt: r.createdAt,
      finalizedAt: r.finalizedAt,
      ...(payslips ? { payslips } : {}),
    };
  }
}
