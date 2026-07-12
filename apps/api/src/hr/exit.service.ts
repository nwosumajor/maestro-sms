// =============================================================================
// ExitService — resignation / termination / retirement with final settlement
// =============================================================================
// MAKER-CHECKER money: hr.write INITIATES an exit — the settlement (pro-rata
// final month + accrued-leave payout − outstanding loans, net ≥ 0) is computed
// by the pure computeFinalSettlement and SNAPSHOTTED encrypted onto the record.
// A DIFFERENT person with hr.salary.approve DECIDES (step-up at the controller).
// Approval, in one tx: employee → EXITED (endDate = last working day), loan
// recovery posted to the append-only repayment ledger (NULL payrollRunId =
// exit recovery; loans SETTLED/updated), then the OFFBOARDING checklist opens
// (account disabling stays a human checklist task — never automatic).
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { computeFinalSettlement, type FinalSettlement, type StaffExitDto } from "@sms/types";
import { decryptField, encryptField } from "../foundation/field-crypto";
import { StaffLifecycleService } from "./staff-lifecycle.service";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

type ExitRow = {
  id: string;
  userId: string;
  type: string;
  lastWorkingDay: Date;
  reason: string | null;
  settlementEnc: string;
  status: string;
  initiatedById: string;
  decidedById: string | null;
  decidedAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class ExitService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly lifecycle: StaffLifecycleService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Maker: initiate an exit; the settlement is computed and frozen here. */
  async initiate(
    p: Principal,
    input: { userId: string; type: "RESIGNATION" | "TERMINATION" | "RETIREMENT"; lastWorkingDay: string; reason?: string },
  ): Promise<StaffExitDto> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.lastWorkingDay)) {
      throw new BadRequestException("lastWorkingDay must be YYYY-MM-DD");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const emp = await tx.employee.findFirst({ where: { userId: input.userId } });
      if (!emp) throw new NotFoundException("Employee record not found");
      if (emp.status !== "ACTIVE") throw new BadRequestException("This employee is not active");
      const dup = await tx.staffExit.findFirst({ where: { userId: input.userId, status: "PENDING" }, select: { id: true } });
      if (dup) throw new BadRequestException("An exit for this employee is already awaiting a decision");

      const base = emp.salaryEnc ? Number(decryptField(emp.salaryEnc, p.schoolId)) : 0;
      // Accrued leave = Σ (entitled − used) across this year's balances.
      const year = new Date(`${input.lastWorkingDay}T00:00:00.000Z`).getUTCFullYear();
      const balances = await tx.leaveBalance.findMany({ where: { userId: input.userId, year } });
      const leaveDaysRemaining = balances.reduce((s, b) => s + Math.max(0, b.entitledDays - b.usedDays), 0);
      const loans = await tx.staffLoan.findMany({ where: { userId: input.userId, status: "ACTIVE" } });
      const loanOutstandingMinor = loans.reduce((s, l) => s + Number(decryptField(l.balanceEnc, p.schoolId)), 0);

      const settlement = computeFinalSettlement({
        baseMinor: base,
        lastWorkingDay: input.lastWorkingDay,
        leaveDaysRemaining,
        loanOutstandingMinor,
      });
      const row = await tx.staffExit.create({
        data: {
          schoolId: p.schoolId,
          userId: input.userId,
          type: input.type,
          lastWorkingDay: new Date(`${input.lastWorkingDay}T00:00:00.000Z`),
          reason: (input.reason ?? "").trim() || null,
          settlementEnc: encryptField(JSON.stringify(settlement), p.schoolId),
          initiatedById: p.userId,
        },
      });
      await this.audit.record(
        // SECURITY: settlement amounts stay out of audit metadata (like salaries).
        { actorId: p.userId, action: "hr.exit.initiate", entity: "staff_exit", entityId: row.id, schoolId: p.schoolId, metadata: { userId: input.userId, type: input.type } },
        tx,
      );
      return this.toDto(p, row as ExitRow, null);
    });
  }

  /** Checker: decide (≠ initiator). Approval applies everything in one tx. */
  async decide(p: Principal, id: string, approve: boolean): Promise<StaffExitDto> {
    const decided = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = (await tx.staffExit.findFirst({ where: { id } })) as ExitRow | null;
      if (!row) throw new NotFoundException("Exit not found");
      if (row.status !== "PENDING") throw new BadRequestException("This exit has already been decided");
      if (row.initiatedById === p.userId) {
        throw new ForbiddenException("An exit must be decided by a different person (separation of duties)");
      }
      if (approve) {
        const emp = await tx.employee.findFirst({ where: { userId: row.userId }, select: { id: true } });
        if (!emp) throw new NotFoundException("Employee record not found");
        await tx.employee.update({
          where: { id: emp.id },
          data: { status: "EXITED", endDate: row.lastWorkingDay },
        });
        // Recover loans against the settlement (order: oldest first), posting
        // ledger rows with NULL payrollRunId (= exit recovery). Anything the
        // settlement can't cover stays on the loan (balance > 0, still ACTIVE).
        const settlement = JSON.parse(decryptField(row.settlementEnc, p.schoolId)) as FinalSettlement;
        let toRecover = settlement.loanRecoveredMinor;
        const loans = await tx.staffLoan.findMany({
          where: { userId: row.userId, status: "ACTIVE" },
          orderBy: { createdAt: "asc" },
        });
        for (const loan of loans) {
          if (toRecover <= 0) break;
          const balance = Number(decryptField(loan.balanceEnc, p.schoolId));
          const take = Math.min(balance, toRecover);
          if (take <= 0) continue;
          await tx.loanRepayment.create({
            data: { schoolId: p.schoolId, loanId: loan.id, payrollRunId: null, userId: row.userId, amountEnc: encryptField(String(take), p.schoolId) },
          });
          const left = balance - take;
          await tx.staffLoan.update({
            where: { id: loan.id },
            data: { balanceEnc: encryptField(String(left), p.schoolId), ...(left <= 0 ? { status: "SETTLED" } : {}) },
          });
          toRecover -= take;
        }
      }
      const updated = await tx.staffExit.update({
        where: { id },
        data: { status: approve ? "APPROVED" : "REJECTED", decidedById: p.userId, decidedAt: new Date() },
      });
      await this.audit.record(
        { actorId: p.userId, action: approve ? "hr.exit.approve" : "hr.exit.reject", entity: "staff_exit", entityId: id, schoolId: p.schoolId, metadata: { userId: row.userId, type: row.type } },
        tx,
      );
      return this.toDto(p, updated as ExitRow, null);
    });
    // Open the offboarding checklist AFTER the exit tx commits (its own tx via
    // the lifecycle service; idempotent enough — HR can also create manually).
    if (approve && decided.status === "APPROVED") {
      try {
        await this.lifecycle.createChecklist(p, decided.userId, "OFFBOARDING");
      } catch {
        /* best-effort — the exit itself is committed */
      }
    }
    return decided;
  }

  /** All exits (hr.read) with names + decrypted settlements (audited). */
  async list(p: Principal): Promise<StaffExitDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = (await tx.staffExit.findMany({ orderBy: { createdAt: "desc" }, take: 100 })) as ExitRow[];
      const users = await tx.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
        select: { id: true, name: true },
      });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      await this.audit.record(
        { actorId: p.userId, action: "hr.exit.list.read", entity: "staff_exit", entityId: p.schoolId, schoolId: p.schoolId, metadata: { count: rows.length } },
        tx,
      );
      return rows.map((r) => this.toDto(p, r, nameById.get(r.userId) ?? null));
    });
  }

  private toDto(p: Principal, r: ExitRow, userName: string | null): StaffExitDto {
    return {
      id: r.id,
      userId: r.userId,
      userName,
      type: r.type as StaffExitDto["type"],
      lastWorkingDay: r.lastWorkingDay,
      reason: r.reason,
      settlement: JSON.parse(decryptField(r.settlementEnc, p.schoolId)) as FinalSettlement,
      status: r.status as StaffExitDto["status"],
      initiatedById: r.initiatedById,
      decidedById: r.decidedById,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
    };
  }
}
