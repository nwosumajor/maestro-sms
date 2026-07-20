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
// VALUE import: Prisma.sql only resolves as a value, not a type (CLAUDE.md).
import { Prisma } from "@sms/db";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

/** One row of the fees aggregate — computed entirely in Postgres. */
interface FeeAggRow {
  invoicedMinor: number;
  collectedMinor: number;
  invoices: number;
}

/** One row of the grade-band aggregate — computed entirely in Postgres. */
interface GradeBandRow {
  a: number;
  b: number;
  c: number;
  d: number;
  f: number;
  graded: number;
  avgPct: number | null;
}

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
      // Computed ENTIRELY in Postgres (SUMs over the billable invoice set and
      // its POSTED payments) rather than shipping every invoice + payment row
      // the school has ever issued into Node just to add them up — same
      // treatment as the grade aggregate below.
      // The money SUMs are cast to ::float8, NOT ::int/::bigint: a school's
      // lifetime kobo total can overflow int4, and Prisma maps int8 to a JS
      // BigInt (which the JSON layer can't serialize). float8 is exact for
      // integers up to 2^53 — identical semantics to the old JS reduce.
      if (p.permissions.includes("fee.read")) {
        const feesSql = Prisma.sql`
          WITH billable AS (
            SELECT id, "totalMinor" FROM "invoice"
            WHERE status NOT IN ('DRAFT', 'CANCELLED')
            ${staff ? Prisma.sql`` : Prisma.sql`AND "studentId" = ANY(${studentIds ?? []}::uuid[])`}
          )
          SELECT
            (SELECT COALESCE(SUM("totalMinor"), 0) FROM billable)::float8 AS "invoicedMinor",
            (SELECT count(*) FROM billable)::int AS invoices,
            (SELECT COALESCE(SUM(CASE WHEN p.kind = 'REFUND' THEN -p."amountMinor" ELSE p."amountMinor" END), 0)
               FROM "payment" p
              WHERE p.status = 'POSTED' AND p."invoiceId" IN (SELECT id FROM billable))::float8 AS "collectedMinor"
        `;
        // A family with no scoped students yet: skip the query, zeros are right.
        const skip = !staff && (!studentIds || studentIds.length === 0);
        const [row]: FeeAggRow[] = skip
          ? [{ invoicedMinor: 0, collectedMinor: 0, invoices: 0 }]
          : await tx.$queryRaw<FeeAggRow[]>(feesSql);
        out.fees = {
          invoicedMinor: row.invoicedMinor,
          collectedMinor: row.collectedMinor,
          outstandingMinor: row.invoicedMinor - row.collectedMinor,
          invoices: row.invoices,
        };
      }

      // --- grade distribution (PUBLISHED grades, by percentage band) ---
      // Computed ENTIRELY in Postgres (band counts + average via FILTER/AVG over
      // a derived pct column) rather than pulling every published grade the
      // school has ever recorded into Node just to sum/bucket them — at 1000+
      // students across years of terms that row count only grows, unbounded.
      // COALESCE(...,0) on a zero maxScore matches the prior JS fallback
      // exactly (counted as 0%, not silently dropped from the average).
      if (p.permissions.includes("grade.read")) {
        const bandSql = Prisma.sql`
          SELECT
            count(*) FILTER (WHERE pct >= 70)::int AS a,
            count(*) FILTER (WHERE pct >= 60 AND pct < 70)::int AS b,
            count(*) FILTER (WHERE pct >= 50 AND pct < 60)::int AS c,
            count(*) FILTER (WHERE pct >= 45 AND pct < 50)::int AS d,
            count(*) FILTER (WHERE pct < 45)::int AS f,
            count(*)::int AS graded,
            ROUND(AVG(pct))::int AS "avgPct"
          FROM (
            -- Cast to numeric BEFORE dividing: score/maxScore as double precision
            -- can land a half-percent average just off a .5 boundary (IEEE-754
            -- can't represent e.g. 0.55 exactly), flipping which way it rounds.
            -- numeric division is exact decimal arithmetic — no such drift.
            SELECT COALESCE(g.score::numeric / NULLIF(g."maxScore", 0)::numeric * 100, 0) AS pct
            FROM "grade" g
            ${staff ? Prisma.sql`` : Prisma.sql`JOIN "submission" s ON s.id = g."submissionId"`}
            WHERE g.status = 'PUBLISHED'
            ${staff ? Prisma.sql`` : Prisma.sql`AND s."studentId" = ANY(${studentIds ?? []}::uuid[])`}
          ) t
        `;
        // A family with no scoped students yet: skip the query, same as the
        // old __none__ short-circuit — the defaults below are already correct.
        const skip = !staff && (!studentIds || studentIds.length === 0);
        const [row]: GradeBandRow[] = skip ? [{ a: 0, b: 0, c: 0, d: 0, f: 0, graded: 0, avgPct: null }] : await tx.$queryRaw<GradeBandRow[]>(bandSql);
        out.grades = {
          A: row.a,
          B: row.b,
          C: row.c,
          D: row.d,
          F: row.f,
          graded: row.graded,
          averagePct: row.avgPct,
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
