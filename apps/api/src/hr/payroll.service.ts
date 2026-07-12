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
import {
  computeBonusPayslip,
  computeFullPayslip,
  computeMonthlyPayslip,
  employerPensionMinor,
  type FullPayslipBreakdown,
  type MyPayslipDto,
  type PayrollRunDto,
  type PayslipDto,
} from "@sms/types";
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

  /** Generate a DRAFT run from active employees' current salaries. MONTHLY runs
   *  apply components + loan recovery; THIRTEENTH/BONUS runs pay a percent of
   *  BASIC only (PAYE applies, no pension/components/loans). */
  async createRun(
    p: Principal,
    periodYear: number,
    periodMonth: number,
    runType: "MONTHLY" | "THIRTEENTH" | "BONUS" = "MONTHLY",
    bonusPercentInput?: number,
  ): Promise<PayrollRunDto> {
    if (periodMonth < 1 || periodMonth > 12) throw new BadRequestException("month must be 1–12");
    const bonusPercent =
      runType === "THIRTEENTH" ? 100 : runType === "BONUS" ? Math.round(bonusPercentInput ?? 0) : null;
    if (runType === "BONUS" && (!bonusPercent || bonusPercent < 1 || bonusPercent > 1000)) {
      throw new BadRequestException("bonus percent must be 1–1000");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const dup = await tx.payrollRun.findFirst({ where: { periodYear, periodMonth, runType } });
      if (dup) throw new ConflictException("A payroll run of that type already exists for that period");

      const employees = await tx.employee.findMany({ where: { status: "ACTIVE" } });
      const userIds = employees.map((e) => e.userId);
      const monthly = runType === "MONTHLY";
      // Recurring components + active loans apply to MONTHLY runs only. The full
      // breakdown is SNAPSHOTTED (encrypted) onto each payslip — later edits to
      // components/loans never rewrite a run.
      const components = monthly && userIds.length
        ? await tx.payComponent.findMany({ where: { userId: { in: userIds }, active: true } })
        : [];
      const loans = monthly && userIds.length
        ? await tx.staffLoan.findMany({
            where: { userId: { in: userIds }, status: "ACTIVE" },
            orderBy: { createdAt: "asc" },
          })
        : [];
      const compsByUser = new Map<string, typeof components>();
      for (const c of components) {
        (compsByUser.get(c.userId) ?? compsByUser.set(c.userId, []).get(c.userId)!).push(c);
      }
      const loansByUser = new Map<string, typeof loans>();
      for (const l of loans) {
        (loansByUser.get(l.userId) ?? loansByUser.set(l.userId, []).get(l.userId)!).push(l);
      }

      let totalGross = 0;
      let totalNet = 0;
      const run = await tx.payrollRun.create({
        data: { schoolId: p.schoolId, periodYear, periodMonth, runType, bonusPercent, status: "DRAFT", runById: p.userId },
      });
      for (const e of employees) {
        const base = e.salaryEnc ? Number(decryptField(e.salaryEnc, p.schoolId)) : 0;
        const mine = compsByUser.get(e.userId) ?? [];
        const myLoans = loansByUser.get(e.userId) ?? [];
        // MONTHLY: statutory (PAYE + pension) on the full gross, loan recovery
        // clamped so net never goes negative. THIRTEENTH/BONUS: percent of basic,
        // PAYE-only — pure, see @sms/types.
        const bd = monthly
          ? computeFullPayslip({
              baseMinor: base,
              allowances: mine.filter((c) => c.kind === "ALLOWANCE").map((c) => ({ name: c.name, amountMinor: c.amountMinor })),
              otherDeductions: mine.filter((c) => c.kind === "DEDUCTION").map((c) => ({ name: c.name, amountMinor: c.amountMinor })),
              loanInstallments: myLoans.map((l) => ({
                loanId: l.id,
                installmentMinor: Math.min(
                  Number(decryptField(l.monthlyEnc, p.schoolId)),
                  Number(decryptField(l.balanceEnc, p.schoolId)),
                ),
              })),
            })
          : computeBonusPayslip(base, bonusPercent ?? 100);
        totalGross += bd.grossMinor;
        totalNet += bd.netMinor;
        await tx.payslip.create({
          data: {
            schoolId: p.schoolId,
            payrollRunId: run.id,
            userId: e.userId,
            grossEnc: encryptField(String(bd.grossMinor), p.schoolId),
            deductionsEnc: encryptField(String(bd.deductionsMinor), p.schoolId),
            netEnc: encryptField(String(bd.netMinor), p.schoolId),
            breakdownEnc: encryptField(JSON.stringify(bd), p.schoolId),
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
      // Concurrency guard: only ONE finalize flips DRAFT -> FINALIZED; a racing
      // second call matches nothing and errors cleanly (no double loan recovery).
      const flipped = await tx.payrollRun.updateMany({
        where: { id, status: "DRAFT" },
        data: { status: "FINALIZED", finalizedById: p.userId, finalizedAt: new Date() },
      });
      if (flipped.count === 0) throw new ConflictException("Run already finalized");
      const updated = (await tx.payrollRun.findFirst({ where: { id } }))!;

      // Loan recovery posts ONLY on finalize (a DRAFT moves no money): for each
      // payslip's snapshotted installments, append the repayment ledger row
      // (unique(loanId,runId) backstops idempotency) and decrement the balance;
      // a balance reaching zero settles the loan.
      const slips = await tx.payslip.findMany({ where: { payrollRunId: id }, select: { userId: true, breakdownEnc: true } });
      let recovered = 0;
      for (const s of slips) {
        if (!s.breakdownEnc) continue;
        const bd = JSON.parse(decryptField(s.breakdownEnc, p.schoolId)) as FullPayslipBreakdown;
        for (const inst of bd.loans ?? []) {
          const loan = await tx.staffLoan.findFirst({ where: { id: inst.loanId } });
          if (!loan || loan.status !== "ACTIVE") continue;
          const balance = Number(decryptField(loan.balanceEnc, p.schoolId));
          const take = Math.min(inst.installmentMinor, balance);
          if (take <= 0) continue;
          await tx.loanRepayment.create({
            data: {
              schoolId: p.schoolId,
              loanId: loan.id,
              payrollRunId: id,
              userId: s.userId,
              amountEnc: encryptField(String(take), p.schoolId),
            },
          });
          const left = balance - take;
          await tx.staffLoan.update({
            where: { id: loan.id },
            data: { balanceEnc: encryptField(String(left), p.schoolId), ...(left <= 0 ? { status: "SETTLED" } : {}) },
          });
          recovered += take;
        }
      }
      const count = slips.length;
      await this.audit.record(
        {
          actorId: p.userId,
          action: "hr.payroll.run.finalize",
          entity: "payroll_run",
          entityId: id,
          schoolId: p.schoolId,
          metadata: { loanRecoveredMinor: recovered },
        },
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
    // Quote + neutralise spreadsheet formula injection (OWASP CSV injection).
    const esc = (s: string) => {
      let v = String(s);
      if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
      return `"${v.replace(/"/g, '""')}"`;
    };
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

  /** Statutory remittance schedule (CSV) for a FINALIZED run. Built from each
   *  payslip's SNAPSHOTTED breakdown — never recomputed — so the schedule always
   *  matches what was actually paid.
   *   - paye:    per-employee TIN + gross + PAYE for the period.
   *   - pension: RSA PIN + employee 8% (from the slip) + employer 10% (cost).
   *   - nhf:     rows only where an "NHF" deduction component was applied.
   */
  async remittanceExport(
    p: Principal,
    runId: string,
    type: "paye" | "pension" | "nhf",
  ): Promise<{ csv: string; filename: string }> {
    const data = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const run = await tx.payrollRun.findFirst({ where: { id: runId } });
      if (!run) throw new NotFoundException("Payroll run not found");
      if (run.status !== "FINALIZED") throw new BadRequestException("Finalize the run before exporting remittances");
      const slips = await tx.payslip.findMany({ where: { payrollRunId: runId } });
      const userIds = slips.map((s) => s.userId);
      const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
      const emps = await tx.employee.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, tinEnc: true, rsaPinEnc: true },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.payroll.remittance.export", entity: "payroll_run", entityId: runId, schoolId: p.schoolId, metadata: { type } },
        tx,
      );
      return { run, slips, nameById: new Map(users.map((u) => [u.id, u.name])), empByUser: new Map(emps.map((e) => [e.userId, e])) };
    });
    // Quote + neutralise spreadsheet formula injection (OWASP CSV injection).
    const esc = (s: string) => {
      let v = String(s);
      if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
      return `"${v.replace(/"/g, '""')}"`;
    };
    const dec = (v: string | null | undefined) => (v ? decryptField(v, p.schoolId) : "");
    const money = (m: number) => (m / 100).toFixed(2);
    const period = `${data.run.periodYear}-${String(data.run.periodMonth).padStart(2, "0")}`;
    const lines: string[] = [];
    for (const s of data.slips) {
      const bd: FullPayslipBreakdown = s.breakdownEnc
        ? (JSON.parse(decryptField(s.breakdownEnc, p.schoolId)) as FullPayslipBreakdown)
        : legacyBreakdown(s.grossEnc ? Number(decryptField(s.grossEnc, p.schoolId)) : 0);
      const name = data.nameById.get(s.userId) ?? "";
      const emp = data.empByUser.get(s.userId);
      if (type === "paye") {
        lines.push([esc(name), esc(dec(emp?.tinEnc)), money(bd.grossMinor), money(bd.payeMinor)].join(","));
      } else if (type === "pension") {
        if (bd.pensionMinor <= 0) continue; // bonus runs carry no pension
        lines.push([
          esc(name),
          esc(dec(emp?.rsaPinEnc)),
          money(bd.grossMinor),
          money(bd.pensionMinor),
          money(employerPensionMinor(bd.grossMinor)),
          money(bd.pensionMinor + employerPensionMinor(bd.grossMinor)),
        ].join(","));
      } else {
        const nhf = bd.otherDeductions.filter((d) => d.name.trim().toUpperCase() === "NHF");
        const total = nhf.reduce((sum, d) => sum + d.amountMinor, 0);
        if (total <= 0) continue; // only staff with an NHF deduction component
        lines.push([esc(name), money(bd.grossMinor), money(total)].join(","));
      }
    }
    const header =
      type === "paye"
        ? '"Employee","TIN","Gross (NGN)","PAYE (NGN)"'
        : type === "pension"
          ? '"Employee","RSA PIN","Gross (NGN)","Employee 8% (NGN)","Employer 10% (NGN)","Total (NGN)"'
          : '"Employee","Gross (NGN)","NHF (NGN)"';
    return {
      csv: [header, ...lines].join("\n") + "\n",
      filename: `${type}-remittance-${period}${data.run.runType !== "MONTHLY" ? `-${data.run.runType.toLowerCase()}` : ""}.csv`,
    };
  }

  /** Render one employee's payslip for a run as a PDF (amounts decrypted
   *  in-memory). `selfOnly` = the staff self-service path: only the caller's OWN
   *  slip, and only once the run is FINALIZED (drafts aren't pay statements). */
  async payslipPdf(
    p: Principal,
    runId: string,
    userId: string,
    opts: { selfOnly?: boolean } = {},
  ): Promise<{ buffer: Buffer; filename: string }> {
    if (opts.selfOnly && userId !== p.userId) throw new NotFoundException("Payslip not found");
    const data = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const run = await tx.payrollRun.findFirst({ where: { id: runId } });
      if (!run) throw new NotFoundException("Payroll run not found");
      if (opts.selfOnly && run.status !== "FINALIZED") throw new NotFoundException("Payslip not found");
      const slip = await tx.payslip.findFirst({ where: { payrollRunId: runId, userId } });
      if (!slip) throw new NotFoundException("Payslip not found");
      const user = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true } });
      const gross = slip.grossEnc ? Number(decryptField(slip.grossEnc, p.schoolId)) : 0;
      // Render from the SNAPSHOTTED breakdown; recompute only for legacy slips
      // that predate the breakdown column (bare salary, so recompute is exact).
      const bd: FullPayslipBreakdown = slip.breakdownEnc
        ? (JSON.parse(decryptField(slip.breakdownEnc, p.schoolId)) as FullPayslipBreakdown)
        : { ...legacyBreakdown(gross) };
      await this.audit.record(
        { actorId: p.userId, action: "hr.payroll.payslip.read", entity: "payslip", entityId: slip.id, schoolId: p.schoolId, metadata: { userId, self: !!opts.selfOnly } },
        tx,
      );
      return { run, name: user?.name ?? "Staff", school: school?.name ?? "School", bd };
    });
    const bd = data.bd;
    const naira = (m: number) => `NGN ${(m / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.fontSize(18).text(data.school, { align: "left" });
      const typeLabel =
        data.run.runType === "THIRTEENTH" ? " (13th month)" : data.run.runType === "BONUS" ? ` (bonus ${data.run.bonusPercent}%)` : "";
      doc.moveDown(0.3).fontSize(13).text(`Payslip — ${data.run.periodMonth}/${data.run.periodYear}${typeLabel}`);
      doc.moveDown(0.5).fontSize(11).text(`Employee: ${data.name}`);
      doc.moveDown(1);
      const line = (label: string, val: string) => doc.fontSize(11).text(label, { continued: true }).text(val, { align: "right" });
      line("Basic salary", naira(bd.baseMinor));
      for (const a of bd.allowances) line(`${a.name} (allowance)`, naira(a.amountMinor));
      doc.moveDown(0.2);
      line("Gross pay", naira(bd.grossMinor));
      doc.moveDown(0.4);
      line("PAYE (income tax)", `- ${naira(bd.payeMinor)}`);
      line("Pension (8%)", `- ${naira(bd.pensionMinor)}`);
      for (const d of bd.otherDeductions) line(d.name, `- ${naira(d.amountMinor)}`);
      for (const l of bd.loans) line("Loan repayment", `- ${naira(l.installmentMinor)}`);
      doc.moveDown(0.3);
      doc.fontSize(12).text("Net pay", { continued: true }).text(naira(bd.netMinor), { align: "right" });
      doc.moveDown(2).fontSize(8).fillColor("#666").text("Generated by the School Management System. Figures in NGN.");
      doc.end();
    });
    return { buffer, filename: `payslip-${data.run.periodYear}-${String(data.run.periodMonth).padStart(2, "0")}-${userId.slice(0, 8)}.pdf` };
  }

  /** Staff self-service: MY payslips across FINALIZED runs (newest first). */
  async myPayslips(p: Principal): Promise<MyPayslipDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const slips = await tx.payslip.findMany({ where: { userId: p.userId } });
      if (slips.length === 0) return [];
      const runs = await tx.payrollRun.findMany({
        where: { id: { in: slips.map((s) => s.payrollRunId) }, status: "FINALIZED" },
        orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
      });
      const slipByRun = new Map(slips.map((s) => [s.payrollRunId, s]));
      await this.audit.record(
        { actorId: p.userId, action: "hr.payroll.payslip.self.list", entity: "payslip", entityId: p.userId, schoolId: p.schoolId },
        tx,
      );
      return runs.map((r) => {
        const s = slipByRun.get(r.id)!;
        return {
          runId: r.id,
          periodYear: r.periodYear,
          periodMonth: r.periodMonth,
          grossMinor: s.grossEnc ? Number(decryptField(s.grossEnc, p.schoolId)) : null,
          netMinor: s.netEnc ? Number(decryptField(s.netEnc, p.schoolId)) : null,
          finalizedAt: r.finalizedAt,
        };
      });
    });
  }

  private decorateRun(
    r: { id: string; periodYear: number; periodMonth: number; runType?: string; bonusPercent?: number | null; status: string; totalGrossMinor: number; totalNetMinor: number; createdAt: Date; finalizedAt: Date | null },
    payslipCount: number,
    payslips: PayslipDto[] | undefined,
  ): PayrollRunDto {
    return {
      id: r.id,
      periodYear: r.periodYear,
      periodMonth: r.periodMonth,
      runType: r.runType ?? "MONTHLY",
      bonusPercent: r.bonusPercent ?? null,
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

/** A pre-breakdown payslip stored only gross (bare salary): reconstruct the
 *  statutory-only breakdown exactly as the original run computed it. */
function legacyBreakdown(grossMinor: number): FullPayslipBreakdown {
  const s = computeMonthlyPayslip(grossMinor);
  return {
    baseMinor: s.grossMinor,
    allowances: [],
    grossMinor: s.grossMinor,
    payeMinor: s.payeMinor,
    pensionMinor: s.pensionMinor,
    otherDeductions: [],
    loans: [],
    deductionsMinor: s.deductionsMinor,
    netMinor: s.netMinor,
  };
}
