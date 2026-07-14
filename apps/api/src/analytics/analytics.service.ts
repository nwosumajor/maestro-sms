// =============================================================================
// AnalyticsService — role-scoped cross-module aggregates (read-only)
// =============================================================================
// Reuses existing module data; every figure is computed INSIDE a tenant
// transaction (RLS) and narrowed by relationship: staff/board see school-wide
// totals, a parent sees their children, a student sees themselves. No figure
// ever crosses a tenant or a family boundary.
// =============================================================================

import { Inject, Injectable } from "@nestjs/common";
import type { AnalyticsOverviewDto } from "@sms/types";
import { ageBand, normalizeGender } from "@sms/types";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const STAFF_WIDE = new Set(["school_admin", "principal", "accountant", "board", "super_admin"]);

@Injectable()
export class AnalyticsService {
  constructor(@Inject(TENANT_DATABASE) private readonly db: TenantDatabase) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isStaff(p: Principal): boolean {
    return p.roles.some((r) => STAFF_WIDE.has(r));
  }

  async overview(p: Principal) {
    // Read-only aggregate — routed to the read replica (when configured) to keep
    // reporting load off the primary writer. Reference use of runAsTenantReadOnly.
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const staff = this.isStaff(p);
      const studentIds = staff ? null : await this.scopedStudentIds(tx, p);
      const since = new Date(Date.now() - 30 * 86_400_000);

      const out: AnalyticsOverviewDto = { scope: staff ? "school" : "family" };

      // --- attendance (last 30 days) ---
      if (p.permissions.includes("attendance.read")) {
        const where: Record<string, unknown> = { createdAt: { gte: since } };
        if (!staff) {
          if (!studentIds || studentIds.length === 0) where.studentId = "__none__";
          else where.studentId = { in: studentIds };
        }
        // groupBy: the DB counts per status — don't ship every row just to count.
        const grouped = await tx.attendanceRecord.groupBy({
          by: ["status"],
          where: where as never, // reason: dynamic where narrowed above; groupBy's generic rejects the loose Record type
          _count: { _all: true },
        });
        const by = { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 };
        let total = 0;
        for (const g of grouped) {
          if (g.status in by) by[g.status as keyof typeof by] = g._count._all;
          total += g._count._all;
        }
        out.attendance = {
          ...by,
          total,
          ratePct: total ? Math.round(((by.PRESENT + by.LATE) / total) * 100) : null,
        };
      }

      // --- fees ---
      if (p.permissions.includes("fee.read")) {
        const invWhere: Record<string, unknown> = {};
        if (!staff) invWhere.studentId = studentIds && studentIds.length ? { in: studentIds } : "__none__";
        const invoices = await tx.invoice.findMany({
          where: invWhere,
          select: { id: true, totalMinor: true, status: true },
        });
        const billable = invoices.filter((i: { status: string }) => i.status !== "DRAFT" && i.status !== "CANCELLED");
        const invoicedMinor = billable.reduce((n: number, i: { totalMinor: number }) => n + i.totalMinor, 0);
        const ids = billable.map((i: { id: string }) => i.id);
        const payments = ids.length
          ? await tx.payment.findMany({
              where: { invoiceId: { in: ids }, status: "POSTED" },
              select: { amountMinor: true, kind: true },
            })
          : [];
        const collectedMinor = payments.reduce(
          (n: number, pmt: { amountMinor: number; kind: string }) =>
            n + (pmt.kind === "REFUND" ? -pmt.amountMinor : pmt.amountMinor),
          0,
        );
        out.fees = {
          invoicedMinor,
          collectedMinor,
          outstandingMinor: invoicedMinor - collectedMinor,
          invoices: billable.length,
        };
      }

      // --- grade distribution (PUBLISHED grades, by percentage band) ---
      if (p.permissions.includes("grade.read")) {
        const gradeWhere: Record<string, unknown> = { status: "PUBLISHED" };
        if (!staff) {
          gradeWhere.submission =
            studentIds && studentIds.length ? { studentId: { in: studentIds } } : { studentId: "__none__" };
        }
        const grades = await tx.grade.findMany({ where: gradeWhere, select: { score: true, maxScore: true } });
        const band = { A: 0, B: 0, C: 0, D: 0, F: 0 };
        let sumPct = 0;
        for (const g of grades) {
          const pct = g.maxScore > 0 ? (g.score / g.maxScore) * 100 : 0;
          sumPct += pct;
          if (pct >= 70) band.A += 1;
          else if (pct >= 60) band.B += 1;
          else if (pct >= 50) band.C += 1;
          else if (pct >= 45) band.D += 1;
          else band.F += 1;
        }
        out.grades = {
          ...band,
          graded: grades.length,
          averagePct: grades.length ? Math.round(sumPct / grades.length) : null,
        };
      }

      // --- student-body demographics (staff, school-wide; needs profile read) ---
      if (staff && p.permissions.includes("student.profile.read")) {
        const profiles = await tx.studentProfile.findMany({ select: { gender: true, dateOfBirth: true, state: true } });
        const gender: Record<string, number> = {};
        const band: Record<string, number> = {};
        const state: Record<string, number> = {};
        for (const pr of profiles) {
          const g = normalizeGender(pr.gender);
          gender[g] = (gender[g] ?? 0) + 1;
          const b = ageBand(pr.dateOfBirth);
          band[b] = (band[b] ?? 0) + 1;
          const st = (pr.state ?? "").trim() || "Unknown";
          state[st] = (state[st] ?? 0) + 1;
        }
        out.demographics = { profiled: profiles.length, gender, ageBand: band, state };
      }

      // --- school operations (staff) ---
      if (staff) {
        const counts: Record<string, number> = {};
        // COUNT in the database — never findMany().length (ships whole ID sets).
        // students needs COUNT(DISTINCT) which Prisma count() can't express, so
        // groupBy on studentId and count the groups (still no row payloads).
        const enr = await tx.enrollment.groupBy({ by: ["studentId"] });
        counts.students = enr.length;
        counts.classes = await tx.class.count();
        if (p.permissions.includes("workflow.read")) {
          counts.pendingApprovals = await tx.workflowRequest.count({ where: { state: "PENDING_REVIEW" } });
        }
        if (p.permissions.includes("integrity.report.read")) {
          counts.integritySignals = await tx.integritySignal.count({ where: { createdAt: { gte: since } } });
        }
        out.operations = counts;
      }

      return out;
    });
  }

  private async scopedStudentIds(tx: TenantTx, p: Principal): Promise<string[]> {
    const ids = new Set<string>();
    if (p.roles.includes("student")) ids.add(p.userId);
    const links = await tx.parentChild.findMany({ where: { parentId: p.userId }, select: { studentId: true } });
    links.forEach((l: { studentId: string }) => ids.add(l.studentId));
    return [...ids];
  }
}
