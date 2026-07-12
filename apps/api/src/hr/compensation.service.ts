// =============================================================================
// CompensationService — recurring pay components + staff loans / advances
// =============================================================================
// Pay components (allowances/deductions) are HR-managed CONFIG; payroll runs
// snapshot the applied breakdown so history never rewrites. Loans are MAKER-
// CHECKER money: staff self-request (hr.self) → a DIFFERENT person holding
// hr.salary.approve decides (step-up at the controller) → recovery happens only
// through FINALIZED payroll runs (append-only loan_repayment ledger). Amounts
// are integer kobo, field-ENCRYPTED at rest like salaries. Tenant-isolated
// (RLS); every mutation audited; staff see their OWN loans only.
// =============================================================================

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PayComponentDto, StaffLoanDto } from "@sms/types";
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

const MAX_LOAN_MINOR = 50_000_000_00; // ₦50m sanity cap

type LoanRow = {
  id: string;
  userId: string;
  purpose: string;
  principalEnc: string;
  monthlyEnc: string;
  balanceEnc: string;
  status: string;
  requestedById: string;
  decidedById: string | null;
  decidedAt: Date | null;
  comment: string | null;
  createdAt: Date;
};

@Injectable()
export class CompensationService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- pay components (hr.write manages; hr.read views) ----------------------
  async listComponents(p: Principal, userId: string): Promise<PayComponentDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.payComponent.findMany({ where: { userId }, orderBy: [{ kind: "asc" }, { name: "asc" }] });
      return rows.map((r) => this.toComponentDto(r));
    });
  }

  async addComponent(
    p: Principal,
    userId: string,
    input: { kind: "ALLOWANCE" | "DEDUCTION"; name: string; amountMinor: number },
  ): Promise<PayComponentDto> {
    const name = (input.name ?? "").trim();
    if (!name) throw new BadRequestException("name is required");
    const amount = Math.round(input.amountMinor);
    if (!(amount > 0)) throw new BadRequestException("amount must be positive");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const emp = await tx.employee.findFirst({ where: { userId }, select: { id: true } });
      if (!emp) throw new NotFoundException("Employee record not found");
      const row = await tx.payComponent.create({
        data: { schoolId: p.schoolId, userId, kind: input.kind, name, amountMinor: amount, createdById: p.userId },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "hr.pay.component.add",
          entity: "pay_component",
          entityId: row.id,
          schoolId: p.schoolId,
          metadata: { userId, kind: input.kind, name, amountMinor: amount },
        },
        tx,
      );
      return this.toComponentDto(row);
    });
  }

  async removeComponent(p: Principal, componentId: string): Promise<{ deleted: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.payComponent.findFirst({ where: { id: componentId } });
      if (!row) throw new NotFoundException("Pay component not found");
      await tx.payComponent.delete({ where: { id: componentId } });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "hr.pay.component.remove",
          entity: "pay_component",
          entityId: componentId,
          schoolId: p.schoolId,
          metadata: { userId: row.userId, kind: row.kind, name: row.name },
        },
        tx,
      );
      return { deleted: true };
    });
  }

  // --- loans (maker-checker) --------------------------------------------------
  /** Staff self-request a loan/advance (PENDING; no money moves). */
  async requestLoan(
    p: Principal,
    input: { principalMinor: number; monthlyMinor: number; purpose: string },
  ): Promise<StaffLoanDto> {
    const principal = Math.round(input.principalMinor);
    const monthly = Math.round(input.monthlyMinor);
    const purpose = (input.purpose ?? "").trim();
    if (!purpose) throw new BadRequestException("purpose is required");
    if (!(principal > 0) || principal > MAX_LOAN_MINOR) throw new BadRequestException("invalid principal");
    if (!(monthly > 0) || monthly > principal) {
      throw new BadRequestException("monthly repayment must be positive and not exceed the principal");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const emp = await tx.employee.findFirst({ where: { userId: p.userId }, select: { id: true } });
      if (!emp) throw new BadRequestException("You need an employment record to request a loan");
      const open = await tx.staffLoan.count({ where: { userId: p.userId, status: { in: ["PENDING", "ACTIVE"] } } });
      if (open >= 3) throw new BadRequestException("You already have 3 open loans/requests");
      const row = await tx.staffLoan.create({
        data: {
          schoolId: p.schoolId,
          userId: p.userId,
          purpose,
          principalEnc: encryptField(String(principal), p.schoolId),
          monthlyEnc: encryptField(String(monthly), p.schoolId),
          balanceEnc: encryptField(String(principal), p.schoolId),
          status: "PENDING",
          requestedById: p.userId,
        },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "hr.loan.request",
          entity: "staff_loan",
          entityId: row.id,
          schoolId: p.schoolId,
          // SECURITY: amounts stay out of audit metadata (mirrors salary handling).
          metadata: { userId: p.userId },
        },
        tx,
      );
      return this.toLoanDto(p, row as LoanRow, null);
    });
  }

  /** Checker decides. Separation of duties: the requester can never decide. */
  async decideLoan(p: Principal, loanId: string, approve: boolean, comment?: string): Promise<StaffLoanDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = (await tx.staffLoan.findFirst({ where: { id: loanId } })) as LoanRow | null;
      if (!row) throw new NotFoundException("Loan not found");
      if (row.status !== "PENDING") throw new BadRequestException("This loan has already been decided");
      if (row.requestedById === p.userId || row.userId === p.userId) {
        throw new ForbiddenException("A loan must be decided by a different person (separation of duties)");
      }
      const updated = await tx.staffLoan.update({
        where: { id: loanId },
        data: {
          status: approve ? "ACTIVE" : "REJECTED",
          decidedById: p.userId,
          decidedAt: new Date(),
          comment: (comment ?? "").trim() || null,
        },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: approve ? "hr.loan.approve" : "hr.loan.reject",
          entity: "staff_loan",
          entityId: loanId,
          schoolId: p.schoolId,
          metadata: { userId: row.userId },
        },
        tx,
      );
      return this.toLoanDto(p, updated as LoanRow, null);
    });
  }

  /** My loans (staff self-service) with recovery history. */
  async myLoans(p: Principal): Promise<StaffLoanDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = (await tx.staffLoan.findMany({
        where: { userId: p.userId },
        orderBy: { createdAt: "desc" },
      })) as LoanRow[];
      const out: StaffLoanDto[] = [];
      for (const r of rows) out.push(await this.withRepayments(p, tx, r));
      return out;
    });
  }

  /** All loans (HR view, hr.read). Reads decrypt amounts — audit-logged. */
  async listLoans(p: Principal): Promise<StaffLoanDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = (await tx.staffLoan.findMany({ orderBy: { createdAt: "desc" } })) as LoanRow[];
      const users = await tx.user.findMany({
        where: { id: { in: rows.map((r) => r.userId) } },
        select: { id: true, name: true },
      });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      await this.audit.record(
        { actorId: p.userId, action: "hr.loan.list.read", entity: "staff_loan", entityId: "all", schoolId: p.schoolId, metadata: { count: rows.length } },
        tx,
      );
      return rows.map((r) => this.toLoanDto(p, r, nameById.get(r.userId) ?? null));
    });
  }

  private async withRepayments(p: Principal, tx: TenantTx, r: LoanRow): Promise<StaffLoanDto> {
    const reps = await tx.loanRepayment.findMany({ where: { loanId: r.id }, orderBy: { createdAt: "asc" } });
    const runIds = reps.map((x) => x.payrollRunId).filter((id): id is string => id !== null);
    const runs = await tx.payrollRun.findMany({
      where: { id: { in: runIds } },
      select: { id: true, periodYear: true, periodMonth: true },
    });
    const runById = new Map(runs.map((x) => [x.id, x]));
    const dto = this.toLoanDto(p, r, null);
    dto.repayments = reps.map((x) => {
      const run = x.payrollRunId ? runById.get(x.payrollRunId) : undefined;
      return {
        payrollRunId: x.payrollRunId,
        period: run ? `${run.periodMonth}/${run.periodYear}` : "exit settlement",
        amountMinor: Number(decryptField(x.amountEnc, p.schoolId)),
        createdAt: x.createdAt,
      };
    });
    return dto;
  }

  private toComponentDto(r: {
    id: string; userId: string; kind: string; name: string; amountMinor: number; active: boolean; createdAt: Date;
  }): PayComponentDto {
    return {
      id: r.id,
      userId: r.userId,
      kind: r.kind as PayComponentDto["kind"],
      name: r.name,
      amountMinor: r.amountMinor,
      active: r.active,
      createdAt: r.createdAt,
    };
  }

  private toLoanDto(p: Principal, r: LoanRow, userName: string | null): StaffLoanDto {
    return {
      id: r.id,
      userId: r.userId,
      userName,
      purpose: r.purpose,
      principalMinor: Number(decryptField(r.principalEnc, p.schoolId)),
      monthlyMinor: Number(decryptField(r.monthlyEnc, p.schoolId)),
      balanceMinor: Number(decryptField(r.balanceEnc, p.schoolId)),
      status: r.status as StaffLoanDto["status"],
      requestedById: r.requestedById,
      decidedById: r.decidedById,
      decidedAt: r.decidedAt,
      comment: r.comment,
      createdAt: r.createdAt,
    };
  }
}
