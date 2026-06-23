// =============================================================================
// AnalyticsService — role-scoped cross-module aggregates (read-only)
// =============================================================================
// Reuses existing module data; every figure is computed INSIDE a tenant
// transaction (RLS) and narrowed by relationship: staff/board see school-wide
// totals, a parent sees their children, a student sees themselves. No figure
// ever crosses a tenant or a family boundary.
// =============================================================================

import { Inject, Injectable } from "@nestjs/common";
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
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const staff = this.isStaff(p);
      const studentIds = staff ? null : await this.scopedStudentIds(tx, p);
      const since = new Date(Date.now() - 30 * 86_400_000);

      const out: Record<string, unknown> = { scope: staff ? "school" : "family" };

      // --- attendance (last 30 days) ---
      if (p.permissions.includes("attendance.read")) {
        const where: Record<string, unknown> = { createdAt: { gte: since } };
        if (!staff) {
          if (!studentIds || studentIds.length === 0) where.studentId = "__none__";
          else where.studentId = { in: studentIds };
        }
        const recs = await tx.attendanceRecord.findMany({ where, select: { status: true } });
        const by = { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 } as Record<string, number>;
        for (const r of recs as Array<{ status: string }>) by[r.status] = (by[r.status] ?? 0) + 1;
        const total = recs.length;
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

      // --- school operations (staff) ---
      if (staff) {
        const counts: Record<string, number> = {};
        const enr = await tx.enrollment.findMany({ select: { studentId: true }, distinct: ["studentId"] });
        counts.students = enr.length;
        counts.classes = (await tx.class.findMany({ select: { id: true } })).length;
        if (p.permissions.includes("workflow.read")) {
          counts.pendingApprovals = (
            await tx.workflowRequest.findMany({ where: { state: "PENDING_REVIEW" }, select: { id: true } })
          ).length;
        }
        if (p.permissions.includes("integrity.report.read")) {
          counts.integritySignals = (
            await tx.integritySignal.findMany({ where: { createdAt: { gte: since } }, select: { id: true } })
          ).length;
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
