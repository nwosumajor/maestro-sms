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
import { csvCell } from "../common/csv";
import PDFDocument from "pdfkit";
import {
  computeBonusPayslip,
  computeFullPayslip,
  computeMonthlyPayslip,
  hasPayrollPack,
  employerPensionMinor,
  type FullPayslipBreakdown,
  type MyPayslipDto,
  type PayrollRunDto,
  type PayslipDto,
  formatMoney,
  toMajor,
  currencyDecimals,
} from "@sms/types";
import { decryptField, encryptField } from "../foundation/field-crypto";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { SchoolRegionService } from "../foundation/school-region.service";
import { toMinor } from "../common/money";

@Injectable()
export class PayrollService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly region: SchoolRegionService,
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
    // STATUTORY PAYROLL IS COUNTRY LAW. A school in a country we have not
    // implemented gets a clear refusal rather than Nigerian PAYE bands applied to
    // a foreign salary — a payslip that is confidently wrong about tax is handed
    // to an employee AND to a revenue authority.
    const region = await this.region.forSchool(p.schoolId);
    if (!hasPayrollPack(region.payrollPack)) {
      throw new BadRequestException(
        `Statutory payroll is not available for ${region.country} yet. ` +
          `Tax rules differ by country and this school's are not implemented, so payroll is disabled rather than computed with another country's bands.`,
      );
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

      // Compute EVERY breakdown first, so the run can be refused wholesale if any
      // employee's net would be negative — i.e. their statutory + deduction
      // components exceed their pay. Loans are already clamped (they never push
      // net below zero); a negative net can only come from over-large DEDUCTION
      // components, which is an admin data-entry error, not a pay instruction.
      // A statutory pack REFUSES a period it has no rates for — the UK's thresholds
      // move every 6 April, so a period beyond the loaded years is unavailable
      // rather than computed with the previous year's figures. That refusal must
      // reach the school as a legible 400 explaining what to do, not as a 500:
      // "internal server error" tells a bursar nothing and sends them to support
      // instead of to the person who updates the rates.
      const priced = (fn: () => FullPayslipBreakdown): FullPayslipBreakdown => {
        try {
          return fn();
        } catch (err) {
          throw new BadRequestException((err as Error).message);
        }
      };

      // Nothing is persisted until this passes (the tx rolls back on throw).
      const computed = employees.map((e) => {
        const base = e.salaryEnc ? Number(decryptField(e.salaryEnc, p.schoolId)) : 0;
        const mine = compsByUser.get(e.userId) ?? [];
        const myLoans = loansByUser.get(e.userId) ?? [];
        // MONTHLY: statutory (PAYE + pension) on the full gross, loan recovery
        // clamped so net never goes negative. THIRTEENTH/BONUS: percent of basic,
        // PAYE-only — pure, see @sms/types.
        const bd = monthly
          ? priced(() => computeFullPayslip({
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
              payrollPack: region.payrollPack ?? undefined,
              // The month being PAID, not today: re-running an old period must use
              // that period's rules, which is what makes a country with annual
              // thresholds (the UK) correct rather than merely recent.
              period: new Date(Date.UTC(periodYear, periodMonth - 1, 15)),
            }))
          : priced(() =>
              computeBonusPayslip(
                base,
                bonusPercent ?? 100,
                region.payrollPack ?? undefined,
                new Date(Date.UTC(periodYear, periodMonth - 1, 15)),
              ),
            );
        return { e, bd };
      });

      const overdrawn = computed.filter(({ bd }) => bd.netMinor < 0);
      if (overdrawn.length > 0) {
        const names = await tx.user.findMany({
          where: { id: { in: overdrawn.map((o) => o.e.userId) } },
          select: { id: true, name: true },
        });
        const nameById = new Map(names.map((u) => [u.id, u.name]));
        // Named for the currency it formats, which is the school's, not ours.
        const cash = (m: number) => formatMoney(m, region.currency, region.locale);
        const list = overdrawn
          .map((o) => `${nameById.get(o.e.userId) ?? o.e.userId} (deductions exceed pay by ${cash(-o.bd.netMinor)})`)
          .join("; ");
        throw new BadRequestException(
          `Cannot generate payroll — deductions exceed pay for ${overdrawn.length} employee(s): ${list}. ` +
            `Reduce their deduction components, then generate the run again.`,
        );
      }

      let totalGross = 0;
      let totalNet = 0;
      const run = await tx.payrollRun.create({
        data: { schoolId: p.schoolId, periodYear, periodMonth, runType, bonusPercent, status: "DRAFT", runById: p.userId },
      });
      for (const { e, bd } of computed) {
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
      return this.decorateRun(updated, employees.length, undefined, await this.signatories(tx, [updated]));
    });
  }

  async listRuns(p: Principal): Promise<PayrollRunDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const runs = await tx.payrollRun.findMany({ orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }] });
      if (runs.length === 0) return [];
      // Batch the payslip counts in ONE groupBy (not one count per run).
      const counts = await tx.payslip.groupBy({
        by: ["payrollRunId"],
        where: { payrollRunId: { in: runs.map((r) => r.id) } },
        _count: { _all: true },
      });
      const byRun = new Map(counts.map((c) => [c.payrollRunId, c._count._all]));
      // ONE lookup for the page, then map.
      const nameOf = await this.signatories(tx, runs);
      return runs.map((r) => this.decorateRun(r, byRun.get(r.id) ?? 0, undefined, nameOf));
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
      return this.decorateRun(run, slips.length, payslips, await this.signatories(tx, [run]));
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
      return this.decorateRun(updated, count, undefined, await this.signatories(tx, [updated]));
    });
  }

  /**
   * Bank-transfer export (CSV) for a run: name, bank, account, net pay.
   *
   * FINALIZED ONLY. This file is a payment instruction — it is what somebody
   * uploads to the bank — and finalizing is deliberately maker-checker
   * (creator !== finalizer) so that one person cannot pay the staff alone.
   * Handing out the payment file for a DRAFT run bypassed that second signature
   * entirely: one person could create a run and download the instructions for
   * figures nobody else had ever seen. Verified live before the fix — 14 rows
   * of names, banks, account numbers and net pay from an unfinalized run.
   *
   * The remittance CSVs in this same service were already gated this way, which
   * is what makes this an oversight rather than a decision.
   */
  async bankExport(p: Principal, runId: string): Promise<{ csv: string; filename: string }> {
    // The school's REAL currency. This file is an instruction to a bank, not a
    // screen: it carried a hard-coded "Net (NGN)" header and divided by 100
    // unconditionally, so in a zero-decimal currency (the CFA franc and ten
    // others in the catalogue) every staff member would have been paid a
    // HUNDREDTH of their salary, with the column still labelled naira.
    const region = await this.region.forSchool(p.schoolId);
    const rows = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const run = await tx.payrollRun.findFirst({ where: { id: runId } });
      if (!run) throw new NotFoundException("Payroll run not found");
      if (run.status !== "FINALIZED") {
        throw new BadRequestException(
          "Finalize the run before exporting the bank file — it has to be approved by a second person first.",
        );
      }
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
    const lines = [`"Employee","Bank","Account","Net (${region.currency})"`];
    for (const s of rows.slips) {
      const emp = rows.empByUser.get(s.userId);
      // toMajor asks the currency how many minor units it has, instead of
      // assuming two.
      const net = s.netEnc ? toMajor(Number(decryptField(s.netEnc, p.schoolId)), region.currency) : 0;
      lines.push([
        csvCell(rows.nameById.get(s.userId) ?? ""),
        csvCell(dec(emp?.bankNameEnc)),
        csvCell(dec(emp?.bankAccountEnc)),
        net.toFixed(currencyDecimals(region.currency)),
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
    const dec = (v: string | null | undefined) => (v ? decryptField(v, p.schoolId) : "");
    // ASK THE CURRENCY, do not assume two decimals. This file is filed with a
    // revenue authority and a pension administrator, and `/100` is right for
    // NGN and GBP and 100x WRONG for the CFA franc and every other zero-decimal
    // currency — eleven of the twenty-nine African countries in the catalogue.
    // The BANK EXPORT beside this one already did it properly (toMajor +
    // currencyDecimals); this one was missed.
    //
    // Latent rather than live today: PAYROLL_PACKS implements NG and GB only and
    // createRun REFUSES a country without a pack, so no zero-decimal school can
    // reach this yet. It would go wrong silently on the day one is added, which
    // is the worst moment to find it.
    const region = await this.region.forSchool(p.schoolId);
    const money = (m: number) => toMajor(m, region.currency).toFixed(currencyDecimals(region.currency));
    const period = `${data.run.periodYear}-${String(data.run.periodMonth).padStart(2, "0")}`;
    const lines: string[] = [];
    for (const s of data.slips) {
      const bd: FullPayslipBreakdown = s.breakdownEnc
        ? (JSON.parse(decryptField(s.breakdownEnc, p.schoolId)) as FullPayslipBreakdown)
        : legacyBreakdown(s.grossEnc ? Number(decryptField(s.grossEnc, p.schoolId)) : 0);
      const name = data.nameById.get(s.userId) ?? "";
      const emp = data.empByUser.get(s.userId);
      if (type === "paye") {
        lines.push([csvCell(name), csvCell(dec(emp?.tinEnc)), money(bd.grossMinor), money(bd.payeMinor)].join(","));
      } else if (type === "pension") {
        if (bd.pensionMinor <= 0) continue; // bonus runs carry no pension
        lines.push([
          csvCell(name),
          csvCell(dec(emp?.rsaPinEnc)),
          money(bd.grossMinor),
          money(bd.pensionMinor),
          money(employerPensionMinor(bd.grossMinor)),
          money(bd.pensionMinor + employerPensionMinor(bd.grossMinor)),
        ].join(","));
      } else {
        const nhf = bd.otherDeductions.filter((d) => d.name.trim().toUpperCase() === "NHF");
        const total = nhf.reduce((sum, d) => sum + d.amountMinor, 0);
        if (total <= 0) continue; // only staff with an NHF deduction component
        lines.push([csvCell(name), money(bd.grossMinor), money(total)].join(","));
      }
    }
    // And the COLUMN NAMES follow the currency too. Getting the figures right
    // while heading the column "Gross (NGN)" produces a filing that states the
    // wrong currency — which on a statutory return is not a cosmetic problem,
    // because the number and its unit are read together. The bank export beside
    // this one already interpolates `region.currency`.
    const cur = region.currency;
    const header =
      type === "paye"
        ? `"Employee","TIN","Gross (${cur})","PAYE (${cur})"`
        : type === "pension"
          ? `"Employee","RSA PIN","Gross (${cur})","Employee 8% (${cur})","Employer 10% (${cur})","Total (${cur})"`
          : `"Employee","Gross (${cur})","NHF (${cur})"`;
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
    // The SCHOOL's currency and locale, not the platform's. A British payslip
    // printed "NGN" beside every figure and called the deduction "Pension (8%)",
    // which is a Nigerian rate on a British salary.
    const region = await this.region.forSchool(p.schoolId);
    // The locale was already right here; the /100 was not. formatMoney asks Intl
    // how many minor units the currency actually has.
    //
    // No try/catch: formatMoney cannot throw — an unknown currency or locale
    // falls back INSIDE it, to `${currency} ${major.toFixed(currencyDecimals)}`,
    // which is still scaled correctly. The catch that used to be here was
    // unreachable, and its body divided by 100, so the one arm of this that
    // would have been wrong was the one that could never run.
    const cash = (m: number) => formatMoney(m, region.currency, region.locale);
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
      line("Basic salary", cash(bd.baseMinor));
      for (const a of bd.allowances) line(`${a.name} (allowance)`, cash(a.amountMinor));
      doc.moveDown(0.2);
      line("Gross pay", cash(bd.grossMinor));
      doc.moveDown(0.4);
      line("PAYE (income tax)", `- ${cash(bd.payeMinor)}`);
      // National Insurance is a separate line where a country has one; countries
      // that fold it into the pension contribution simply have no such line.
      if (bd.niMinor) line("National Insurance", `- ${cash(bd.niMinor)}`);
      // No rate in the label: the percentage differs by country and by year, and a
      // wrong one printed on a payslip is worse than none.
      line("Pension", `- ${cash(bd.pensionMinor)}`);
      for (const d of bd.otherDeductions) line(d.name, `- ${cash(d.amountMinor)}`);
      for (const l of bd.loans) line("Loan repayment", `- ${cash(l.installmentMinor)}`);
      doc.moveDown(0.3);
      doc.fontSize(12).text("Net pay", { continued: true }).text(cash(bd.netMinor), { align: "right" });
      doc.moveDown(2).fontSize(8).fillColor("#666").text(`Generated by the School Management System. Figures in ${region.currency}.`);
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

  /**
   * Names for the two signatures on a run. ONE lookup for a whole page of runs,
   * not one per run.
   *
   * A payroll run is maker-checker and both halves were recorded and neither
   * exposed — see the DTO. `finalizedById` in particular was written by
   * `finalize()` and read by nothing at all.
   */
  private async signatories(
    tx: TenantTx,
    runs: Array<{ runById: string; finalizedById: string | null }>,
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(runs.flatMap((r) => [r.runById, r.finalizedById]).filter((v): v is string => !!v)),
    ];
    if (ids.length === 0) return new Map();
    const people = (await tx.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    })) as Array<{ id: string; name: string }>;
    return new Map(people.map((u) => [u.id, u.name]));
  }

  private decorateRun(
    r: { id: string; periodYear: number; periodMonth: number; runType?: string; bonusPercent?: number | null; status: string; totalGrossMinor: bigint | number; totalNetMinor: bigint | number; createdAt: Date; finalizedAt: Date | null; runById: string; finalizedById: string | null },
    payslipCount: number,
    payslips: PayslipDto[] | undefined,
    nameOf?: Map<string, string>,
  ): PayrollRunDto {
    return {
      id: r.id,
      periodYear: r.periodYear,
      periodMonth: r.periodMonth,
      runType: r.runType ?? "MONTHLY",
      bonusPercent: r.bonusPercent ?? null,
      status: r.status,
      totalGrossMinor: toMinor(r.totalGrossMinor),
      totalNetMinor: toMinor(r.totalNetMinor),
      payslipCount,
      createdAt: r.createdAt,
      finalizedAt: r.finalizedAt,
      runById: r.runById,
      runByName: nameOf?.get(r.runById) ?? "Unknown",
      finalizedById: r.finalizedById,
      finalizedByName: r.finalizedById ? nameOf?.get(r.finalizedById) ?? "Unknown" : null,
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
