// =============================================================================
// HrAnalyticsService — school-wide HR metrics (read-only aggregations)
// =============================================================================
// Tenant-isolated (RLS); gated by hr.read. Pure aggregation over the HR tables —
// headcount, leave utilisation, latest payroll cost, expiring documents, training,
// disciplinary, and appraisal status. No PII (salaries/bank details) is returned.
// =============================================================================

import { decryptField } from "../foundation/field-crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { HrAnalyticsDto } from "@sms/types";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

@Injectable()
export class HrAnalyticsService {
  constructor(@Inject(TENANT_DATABASE) private readonly db: TenantDatabase) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  async getAnalytics(p: Principal): Promise<HrAnalyticsDto> {
    const year = new Date().getUTCFullYear();
    const soon = new Date(Date.now() + 30 * 86_400_000);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const employees = await tx.employee.findMany({ select: { userId: true, status: true, department: true, employmentType: true } });
      const active = employees.filter((e) => e.status === "ACTIVE").length;
      const byDept = countBy(employees.map((e) => e.department ?? "Unassigned"));
      const byType = countBy(employees.map((e) => e.employmentType));
      // Staff ACCOUNTS (any non-student/non-parent role) vs employment RECORDS:
      // an account created via "create profile" has no employee row until HR
      // completes it — surface that gap instead of silently under-counting.
      const staffUsers = await tx.user.findMany({
        where: { roles: { some: { role: { name: { notIn: ["student", "parent"] } } } } },
        select: { id: true },
      });
      const recorded = new Set(employees.map((e) => e.userId));
      const unrecorded = staffUsers.filter((u) => !recorded.has(u.id)).length;

      const [pendingRequests, approvedThisYear, balances] = await Promise.all([
        tx.leaveRequest.count({ where: { status: "PENDING" } }),
        tx.leaveRequest.count({ where: { status: "APPROVED", createdAt: { gte: new Date(Date.UTC(year, 0, 1)) } } }),
        tx.leaveBalance.findMany({ where: { year }, select: { usedDays: true } }),
      ]);
      const daysTakenThisYear = balances.reduce((s, b) => s + b.usedDays, 0);

      const latestRun = await tx.payrollRun.findFirst({ where: { status: "FINALIZED" }, orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }] });
      const payslipCount = latestRun ? await tx.payslip.count({ where: { payrollRunId: latestRun.id } }) : 0;

      const [expiringSoon, trainingPlanned, trainingCompleted, openCases, apprDraft, apprSubmitted, apprAck] = await Promise.all([
        tx.staffDocument.count({ where: { expiresAt: { not: null, lte: soon } } }),
        tx.trainingRecord.count({ where: { status: "PLANNED" } }),
        tx.trainingRecord.count({ where: { status: "COMPLETED" } }),
        tx.disciplinaryCase.count({ where: { status: { in: ["OPEN", "UNDER_REVIEW"] } } }),
        tx.appraisal.count({ where: { status: "DRAFT" } }),
        tx.appraisal.count({ where: { status: "SUBMITTED" } }),
        tx.appraisal.count({ where: { status: "ACKNOWLEDGED" } }),
      ]);

      // --- v2: turnover, tenure, payroll trend, attendance, loans, lifecycle ---
      const yearAgo = new Date(Date.now() - 365 * 86_400_000);
      const in60d = new Date(Date.now() + 60 * 86_400_000);
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const [exitsLast12m, fullEmployees, recentRuns, monthMarks, activeLoans, onProbation, contractsEnding60d] =
        await Promise.all([
          tx.staffExit.count({ where: { status: "APPROVED", decidedAt: { gte: yearAgo } } }),
          tx.employee.findMany({ where: { status: "ACTIVE" }, select: { startDate: true } }),
          tx.payrollRun.findMany({
            where: { status: "FINALIZED" },
            orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
            take: 6,
            select: { periodYear: true, periodMonth: true, runType: true, totalNetMinor: true },
          }),
          tx.staffAttendance.findMany({ where: { date: { gte: monthStart } }, select: { status: true, flagged: true } }),
          tx.staffLoan.findMany({ where: { status: "ACTIVE" }, select: { balanceEnc: true } }),
          tx.employee.count({ where: { status: "ACTIVE", confirmationStatus: "PROBATION" } }),
          tx.employee.count({ where: { status: "ACTIVE", endDate: { not: null, lte: in60d } } }),
        ]);
      const now = Date.now();
      const tenure = { under1y: 0, y1to3: 0, y3to5: 0, over5y: 0 };
      for (const e of fullEmployees) {
        const years = (now - e.startDate.getTime()) / (365.25 * 86_400_000);
        if (years < 1) tenure.under1y++;
        else if (years < 3) tenure.y1to3++;
        else if (years < 5) tenure.y3to5++;
        else tenure.over5y++;
      }
      const att = { present: 0, late: 0, absent: 0, flagged: 0 };
      for (const m of monthMarks) {
        if (m.status === "PRESENT") att.present++;
        else if (m.status === "LATE") att.late++;
        else if (m.status === "ABSENT") att.absent++;
        if (m.flagged) att.flagged++;
      }
      const outstandingMinor = activeLoans.reduce(
        (sum, l) => sum + Number(decryptField(l.balanceEnc, p.schoolId)),
        0,
      );

      return {
        headcount: { active, total: employees.length, staffAccounts: staffUsers.length, unrecorded },
        byDepartment: byDept,
        byEmploymentType: byType.map((t) => ({ type: t.department, count: t.count })),
        leave: { pendingRequests, approvedThisYear, daysTakenThisYear },
        payroll: {
          latestPeriod: latestRun ? `${latestRun.periodMonth}/${latestRun.periodYear}` : null,
          totalNetMinor: latestRun?.totalNetMinor ?? 0,
          payslipCount,
        },
        documents: { expiringSoon },
        training: { planned: trainingPlanned, completed: trainingCompleted },
        disciplinary: { openCases },
        appraisals: { draft: apprDraft, submitted: apprSubmitted, acknowledged: apprAck },
        attrition: {
          exitsLast12m,
          ratePercent: active + exitsLast12m > 0 ? Math.round((exitsLast12m / (active + exitsLast12m)) * 100) : 0,
        },
        tenure,
        payrollTrend: recentRuns
          .reverse()
          .map((r) => ({ period: `${r.periodMonth}/${r.periodYear}`, runType: r.runType, totalNetMinor: r.totalNetMinor })),
        attendanceThisMonth: att,
        loans: { active: activeLoans.length, outstandingMinor },
        lifecycle: { onProbation, contractsEnding60d },
      };
    });
  }
}

function countBy(values: string[]): { department: string; count: number }[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].map(([department, count]) => ({ department, count })).sort((a, b) => b.count - a.count);
}
