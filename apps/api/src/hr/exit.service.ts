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

import { isIsoDay } from "../common/calendar-day";
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { computeFinalSettlement, type FinalSettlement, type StaffExitDto } from "@sms/types";
import { decryptField, encryptField } from "../foundation/field-crypto";
import { endsOnOrBefore, revokeStaffAccessInTx } from "./staff-access";
import { StaffLifecycleService } from "./staff-lifecycle.service";
import { StaffHandoverService } from "./staff-handover.service";
import { NotificationService } from "../notifications/notification.service";
import { SchoolRegionService } from "../foundation/school-region.service";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { asDuplicate } from "../common/unique-violation";

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
  private readonly logger = new Logger("StaffExit");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly lifecycle: StaffLifecycleService,
    private readonly handover: StaffHandoverService,
    private readonly notifications: NotificationService,
    private readonly region: SchoolRegionService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Maker: initiate an exit; the settlement is computed and frozen here. */
  async initiate(
    p: Principal,
    input: { userId: string; type: "RESIGNATION" | "TERMINATION" | "RETIREMENT"; lastWorkingDay: string; reason?: string },
  ): Promise<StaffExitDto> {
    if (!isIsoDay(input.lastWorkingDay)) {
      throw new BadRequestException("lastWorkingDay must be YYYY-MM-DD");
    }
    // The guard below is the sentence a user reads; a partial unique index
    // (migration 20261229000000) is what makes it true when two people press
    // at once. Translate the constraint so the loser of that race is told the
    // same thing as somebody who simply pressed second, not a 500.
    return asDuplicate('An exit for this employee is already awaiting a decision', () =>
      this.db.runAsTenant(this.ctx(p), async (tx) => {
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

      // HAS THE FINAL MONTH ALREADY BEEN PAID?
      //
      // The settlement pays `base × day / daysInMonth` for the final month, and
      // nothing used to ask whether payroll had already covered it. Most schools
      // run payroll before month end: on the 25th, a leaver whose last day is the
      // 28th had already been paid the WHOLE month, and the settlement then paid
      // 28/31 of it again — on ₦300,000 that is a second ₦270,967.74 for a month
      // already discharged.
      //
      // MONTHLY only, and FINALIZED only. A THIRTEENTH or BONUS run pays base
      // without being salary FOR that month (its own comment says so), and a
      // DRAFT run has paid nobody — treating either as payment would swing the
      // error the other way and short the leaver.
      const lastDay = new Date(`${input.lastWorkingDay}T00:00:00.000Z`);
      // Two reads: `Payslip` carries `payrollRunId` as a scalar with a DB-level
      // FK and no Prisma relation — the documented pattern here that keeps the
      // models lean — so the run cannot be filtered through from the payslip.
      const monthRuns = await tx.payrollRun.findMany({
        where: {
          runType: "MONTHLY",
          status: "FINALIZED",
          periodYear: lastDay.getUTCFullYear(),
          periodMonth: lastDay.getUTCMonth() + 1,
        },
        select: { id: true },
      });
      const paidRun = monthRuns.length
        ? await tx.payslip.findFirst({
            where: { userId: input.userId, payrollRunId: { in: monthRuns.map((r) => r.id) } },
            select: { id: true },
          })
        : null;

      const settlement = computeFinalSettlement({
        baseMinor: base,
        lastWorkingDay: input.lastWorkingDay,
        leaveDaysRemaining,
        loanOutstandingMinor,
        finalMonthAlreadyPaid: Boolean(paidRun),
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
    }),
    );
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
      // CLAIM THE DECISION BEFORE SETTLING ANYTHING.
      //
      // The PENDING check above is a read, and everything below WRITES: it
      // posts `loan_repayment` rows against the departing member's outstanding
      // loans and decrements each balance. At READ COMMITTED two approvals both
      // pass the read and both recover the loans — and the unique index does
      // NOT save it, because these repayments carry `payrollRunId: null` and
      // Postgres treats NULLs as distinct, so a second identical row is
      // perfectly legal. The balance is written as `balance - take` from a
      // figure read earlier, so it is a lost update on top.
      //
      // Same transaction, so a refusal further down rolls the claim back.
      const claimed = await tx.staffExit.updateMany({
        where: { id, status: "PENDING" },
        data: { status: approve ? "APPROVED" : "REJECTED" },
      });
      if (claimed.count === 0) throw new BadRequestException("This exit has already been decided");
      if (approve) {
        const emp = await tx.employee.findFirst({ where: { userId: row.userId }, select: { id: true } });
        if (!emp) throw new NotFoundException("Employee record not found");
        await tx.employee.update({
          where: { id: emp.id },
          data: { status: "EXITED", endDate: row.lastWorkingDay },
        });
        // AND END THEIR ACCESS — which nothing did before this.
        //
        // Approving an exit closed the EMPLOYMENT record and stopped there. The
        // account stayed ACTIVE, so a departed teacher could still sign in and
        // still held every permission they left with: grades, attendance,
        // student profiles, medical records, messaging. The offboarding
        // checklist's "Revoke system access" is a TICKBOX — ticking it changes
        // nothing — so the platform looked like it had handled this while doing
        // nothing at all, which is worse than an obvious omission.
        //
        // NOT ALWAYS TODAY. Unlike a pupil's exit, a staff exit is normally
        // approved BEFORE the last working day — someone serving a month's
        // notice still has to teach. Revoking on approval would lock a teacher
        // out of their own classes for their whole notice period. So access
        // ends ON the last working day: immediately if that day has passed,
        // otherwise the daily sweep does it (StaffReminderService.sweep).
        if (endsOnOrBefore(row.lastWorkingDay, await this.region.todayInTx(tx, p.schoolId))) {
          await revokeStaffAccessInTx(tx, row.userId);
        }
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
      // WHAT THEY ARE STILL HOLDING, said out loud, to the person who just
      // approved the exit.
      //
      // The checklist's "Handover notes" is a tickbox; it does not know that
      // this teacher has thirty class-subject assignments and an exam to
      // invigilate a fortnight after their last day. Sent on APPROVAL rather
      // than on the last working day on purpose: approval is when there is
      // still time to hand the work over, and a notice period is the whole
      // window in which that can happen.
      await this.tellSomebodyWhatIsOutstanding(p, decided.userId);
    }
    return decided;
  }

  /**
   * Name the work a departing member of staff still holds, to the people who
   * can hand it over.
   *
   * Best-effort by design: the exit is committed and correct whether or not
   * this notice is sent, and failing the approval because a notification could
   * not be written would be the tail wagging the dog. It is logged instead.
   */
  private async tellSomebodyWhatIsOutstanding(p: Principal, userId: string): Promise<void> {
    try {
      const tz = (await this.region.forSchool(p.schoolId)).timezone;
      const outstanding = await this.db.runAsTenantReadOnly(this.ctx(p), (tx) =>
        this.handover.dutiesIn(tx, userId, tz),
      );
      if (outstanding.total === 0) return;
      const dated = outstanding.duties.filter((d) => d.dated);
      const lines = outstanding.duties.map((d) => `• ${d.label}: ${d.count}`).join("\n");
      await this.notifications.enqueue(this.ctx(p), {
        recipientId: p.userId,
        type: "GENERIC",
        title: `${outstanding.userName ?? "This member of staff"} still holds ${outstanding.total} duties`,
        body:
          `Their exit is approved. Nothing has been reassigned — the platform cannot know who should take it on.\n\n${lines}` +
          (dated.length > 0
            ? `\n\n${dated.reduce((n, d) => n + d.count, 0)} of these are DATED — somebody has to be in a room for them.`
            : ""),
        data: { userId, total: outstanding.total },
        channels: ["EMAIL"],
      });
    } catch (err) {
      this.logger.warn(`could not report outstanding duties for ${userId}: ${(err as Error).message}`);
    }
  }

  /**
   * Close the access of anyone in THIS school whose last working day has passed.
   *
   * The nightly cross-tenant sweep does the whole fleet; this is the same job
   * for one school, on demand. It exists for two reasons the dunning sweep
   * taught us: a scheduled job with no manual trigger cannot be verified after
   * an incident, and "did it run?" is a question an administrator will ask.
   *
   * Shares `endsOnOrBefore` and `revokeStaffAccessInTx` with both the approval
   * path and the nightly sweep, so the three cannot disagree about who should
   * still have access.
   */
  async revokeElapsed(p: Principal): Promise<{ revoked: number; scanned: number }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // The SCHOOL's day, not the server's. The `lte` prefilter stays on `now`
      // — it only has to be generous — and `endsOnOrBefore` makes the decision.
      const now = new Date();
      const today = await this.region.todayInTx(tx, p.schoolId);
      const rows = (await tx.staffExit.findMany({
        where: { status: "APPROVED", lastWorkingDay: { lte: now } },
        select: { userId: true, lastWorkingDay: true },
      })) as Array<{ userId: string; lastWorkingDay: Date }>;
      let revoked = 0;
      for (const r of rows) {
        if (!endsOnOrBefore(r.lastWorkingDay, today)) continue;
        if (await revokeStaffAccessInTx(tx, r.userId)) revoked += 1;
      }
      if (revoked > 0) {
        await this.audit.record(
          {
            actorId: p.userId,
            action: "hr.exit.access.revoked",
            entity: "user",
            entityId: p.schoolId,
            schoolId: p.schoolId,
            metadata: { revoked, scanned: rows.length },
          },
          tx,
        );
      }
      // Reports what it DID and what it LOOKED AT — "revoked 0 of 12 already
      // closed" and "revoked 0 of 0 because nothing ran" are different facts.
      return { revoked, scanned: rows.length };
    });
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
