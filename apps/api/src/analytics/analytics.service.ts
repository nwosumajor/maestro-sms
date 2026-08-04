// =============================================================================
// AnalyticsService — role-scoped cross-module aggregates (read-only)
// =============================================================================
// Reuses existing module data; every figure is computed INSIDE a tenant
// transaction (RLS) and narrowed by relationship: staff/board see school-wide
// totals, a parent sees their children, a student sees themselves. No figure
// ever crosses a tenant or a family boundary.
// =============================================================================

import { Inject, Injectable , Optional } from "@nestjs/common";
import type { AnalyticsOverviewDto } from "@sms/types";
import { normalizeGender,
  resolveGradeBands,
} from "@sms/types";
// VALUE import: Prisma.sql only resolves as a value, not a type (CLAUDE.md).
import { Prisma } from "@sms/db";
import { SchoolRegionService } from "../foundation/school-region.service";
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

/** The age-band aggregate — completed-year buckets computed in Postgres. */
interface AgeBandRow {
  profiled: number;
  unknown: number;
  b0: number;
  b1: number;
  b2: number;
  b3: number;
  b4: number;
  b5: number;
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

// School-wide analytics viewers. junior_admin is the day-to-day operational admin
// and already holds the underlying read grants (attendance/grade/fee.read) — it
// belongs here so it sees the school aggregate instead of an empty "family" view
// (mirrors attendance's SCHOOL_WIDE_ROLES, and closes the same dead-grant gap the
// SIS pass fixed). Roles NOT here (teacher, HR, warden…) get no analytics nav.
const STAFF_WIDE = new Set(["school_admin", "principal", "accountant", "board", "junior_admin"]);

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    // The school's grading scale. Optional so existing unit wirings keep
    // working; absent, the platform default applies — which is what every
    // school that has never chosen one uses anyway.
    @Optional() private readonly regions?: SchoolRegionService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isStaff(p: Principal): boolean {
    return p.roles.some((r) => STAFF_WIDE.has(r));
  }

  /**
   * Resolve the reporting window.
   *
   * Defaults to the CURRENT TERM, not a rolling 30 days. The rolling window was the
   * only option and it could not be changed, so a principal could never ask "how was
   * last term?" — and worse, because report cards and fee figures are term-scoped,
   * the attendance percentage here could disagree with the one printed on the report
   * card with nothing on screen to explain the difference.
   *
   * Falls back to 30 days when no term is configured (fail-open — reporting zero
   * would read as "nothing happened"), and says so in the label either way: a figure
   * with no stated period is the one people misquote.
   */
  private async resolvePeriod(
    tx: TenantTx,
    range?: { termId?: string; from?: string; to?: string },
  ): Promise<{ from: Date; to: Date; label: string; termId: string | null }> {
    const end = (d: Date) => {
      const x = new Date(d);
      x.setUTCHours(23, 59, 59, 999);
      return x;
    };
    // An explicit range wins — it is the most specific thing the caller said.
    if (range?.from && range?.to) {
      return {
        from: new Date(`${range.from}T00:00:00.000Z`),
        to: end(new Date(`${range.to}T00:00:00.000Z`)),
        label: `${range.from} – ${range.to}`,
        termId: null,
      };
    }
    const term = (await tx.term.findFirst({
      where: range?.termId ? { id: range.termId } : { isCurrent: true },
      select: { id: true, name: true, startDate: true, endDate: true },
    })) as { id: string; name: string; startDate: Date | null; endDate: Date | null } | null;
    if (term?.startDate && term.endDate) {
      return { from: term.startDate, to: end(term.endDate), label: term.name, termId: term.id };
    }
    const from = new Date(Date.now() - 30 * 86_400_000);
    return { from, to: new Date(), label: "Last 30 days", termId: null };
  }

  /**
   * The overview as CSV, for the board pack.
   *
   * A principal presenting figures previously retyped them off the screen, which is
   * how a number ends up in minutes that does not match the system. Reuses
   * overview() exactly, so the file cannot drift from the page — and it carries the
   * PERIOD in its own rows, because a sheet of numbers with no stated window is the
   * thing that gets misquoted six months later.
   */
  async overviewCsv(
    p: Principal,
    range?: { termId?: string; from?: string; to?: string },
  ): Promise<{ csv: string; filename: string }> {
    const o = await this.overview(p, range);
    // Formula-injection guard + quoting, same as every other export here (OWASP).
    const esc = (v: string | number | null): string => {
      let s = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const rows: Array<[string, string, string | number | null]> = [];
    rows.push(["Period", "Label", o.period?.label ?? ""]);
    rows.push(["Period", "From", o.period?.from ?? ""]);
    rows.push(["Period", "To", o.period?.to ?? ""]);
    rows.push(["Scope", "Scope", o.scope]);

    if (o.attendance) {
      const a = o.attendance;
      rows.push(["Attendance", "Present", a.PRESENT], ["Attendance", "Absent", a.ABSENT]);
      rows.push(["Attendance", "Late", a.LATE], ["Attendance", "Excused", a.EXCUSED]);
      rows.push(["Attendance", "Records", a.total], ["Attendance", "Rate %", a.ratePct]);
    }
    if (o.fees) {
      // Minor units are the ledger's truth; a rounded major unit in a board pack is
      // how a reconciliation goes missing.
      rows.push(["Fees", "Invoiced (minor)", o.fees.invoicedMinor]);
      rows.push(["Fees", "Collected (minor)", o.fees.collectedMinor]);
      rows.push(["Fees", "Outstanding (minor)", o.fees.outstandingMinor]);
      rows.push(["Fees", "Invoices", o.fees.invoices]);
    }
    if (o.grades) {
      // Whatever bands the school's scale defines — a WAEC school exports nine
      // rows here, a US school five.
      for (const b of o.grades.bands) rows.push(["Grades", `Band ${b.grade}`, b.count]);
      rows.push(["Grades", "Graded", o.grades.graded], ["Grades", "Average %", o.grades.averagePct]);
    }
    if (o.operations) {
      for (const [k, v] of Object.entries(o.operations)) rows.push(["Operations", k, v as number]);
    }

    const csv = ["Section,Metric,Value", ...rows.map((r) => r.map(esc).join(","))].join("\n");
    const stamp = o.period?.from ?? new Date().toISOString().slice(0, 10);
    return { csv, filename: `analytics-${stamp}.csv` };
  }

  async overview(p: Principal, range?: { termId?: string; from?: string; to?: string }) {
    // Read-only aggregate — routed to the read replica (when configured) to keep
    // reporting load off the primary writer. Reference use of runAsTenantReadOnly.
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const staff = this.isStaff(p);
      const studentIds = staff ? null : await this.scopedStudentIds(tx, p);
      const period = await this.resolvePeriod(tx, range);
      const since = period.from;

      const out: AnalyticsOverviewDto = {
        scope: staff ? "school" : "family",
        period: {
          from: period.from.toISOString().slice(0, 10),
          to: period.to.toISOString().slice(0, 10),
          label: period.label,
          termId: period.termId,
        },
      };

      // --- attendance (over the selected period) ---
      if (p.permissions.includes("attendance.read")) {
        // Windowed on the SESSION DATE — the day the register is FOR — not on
        // createdAt. Correcting a register weeks later wrote a row with today's
        // createdAt, so a back-filled absence counted against the wrong period and
        // silently vanished from the one it belonged to.
        const where: Record<string, unknown> = { session: { date: { gte: period.from, lte: period.to } } };
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
        const bands = resolveGradeBands((await this.regions?.academicForSchool(p.schoolId))?.grading);
        // The bands come from the SCHOOL'S OWN SCALE, built into the aggregate
        // rather than hard-coded.
        //
        // They used to be five literal thresholds here, and that was wrong twice
        // over. It had no E band at all, so every mark of 40-44 was counted F on
        // this dashboard while the pupil's report card said E — a pass shown as
        // a fail. And once a school could choose its scale, a school on WAEC or
        // the plus-grades scale saw a distribution that matched none of its
        // report cards. One source of truth now: resolveGradeBands, the same
        // function the report card grades on.
        const bandCols = bands.map((b, i) => {
          const upper = i === 0 ? null : bands[i - 1].min;
          const cond =
            upper === null
              ? Prisma.sql`pct >= ${b.min}`
              : Prisma.sql`pct >= ${b.min} AND pct < ${upper}`;
          // The band's own name is the column alias, quoted — a scale like WAEC
          // uses "A1"/"C6", and an unquoted alias would not survive that.
          return Prisma.sql`count(*) FILTER (WHERE ${cond})::int AS ${Prisma.raw(`"${b.grade.replace(/"/g, "")}"`)}`;
        });
        const bandSql = Prisma.sql`
          SELECT
            ${Prisma.join(bandCols, ", ")},
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
        const [row] = skip
          ? [{ graded: 0, avgPct: null } as Record<string, number | null>]
          : await tx.$queryRaw<Array<Record<string, number | null>>>(bandSql);
        out.grades = {
          // Every band the school's scale defines, in its own order — so a WAEC
          // school sees nine and a US school five, rather than a fixed A-F.
          bands: bands.map((b) => ({ grade: b.grade, count: Number(row?.[b.grade] ?? 0) })),
          graded: Number(row?.graded ?? 0),
          averagePct: (row?.avgPct as number | null) ?? null,
        };
      }

      // --- student-body demographics (staff, school-wide; needs profile read) ---
      // Bucketed ENTIRELY in Postgres (GROUP BY gender/state + FILTER age bands)
      // rather than shipping every student_profile row into Node just to tally —
      // same treatment as the grade/fee aggregates. Gender and state are grouped
      // by RAW value and then folded through normalizeGender / trim in JS over the
      // small grouped result (a handful of rows), so the normalisation stays a
      // single source of truth and two spellings of one gender still merge. The
      // age band uses Postgres age(), whose completed-year count matches the pure
      // ageYears() the DTO used before (NULL / out-of-range DOB → "Unknown").
      if (staff && p.permissions.includes("student.profile.read")) {
        const [genderRows, stateRows, [bandRow]] = await Promise.all([
          tx.$queryRaw<Array<{ gender: string | null; n: number }>>(Prisma.sql`
            SELECT gender, count(*)::int AS n FROM "student_profile" GROUP BY gender
          `),
          tx.$queryRaw<Array<{ state: string | null; n: number }>>(Prisma.sql`
            SELECT state, count(*)::int AS n FROM "student_profile" GROUP BY state
          `),
          tx.$queryRaw<Array<AgeBandRow>>(Prisma.sql`
            SELECT
              count(*)::int AS profiled,
              count(*) FILTER (WHERE age IS NULL)::int AS unknown,
              count(*) FILTER (WHERE age <= 5)::int AS b0,
              count(*) FILTER (WHERE age BETWEEN 6 AND 10)::int AS b1,
              count(*) FILTER (WHERE age BETWEEN 11 AND 13)::int AS b2,
              count(*) FILTER (WHERE age BETWEEN 14 AND 16)::int AS b3,
              count(*) FILTER (WHERE age BETWEEN 17 AND 18)::int AS b4,
              count(*) FILTER (WHERE age >= 19)::int AS b5
            FROM (
              SELECT (CASE WHEN a >= 0 AND a < 130 THEN a ELSE NULL END) AS age FROM (
                SELECT date_part('year', age("dateOfBirth"))::int AS a FROM "student_profile"
              ) x
            ) t
          `),
        ]);
        const gender: Record<string, number> = {};
        for (const r of genderRows) {
          const g = normalizeGender(r.gender);
          gender[g] = (gender[g] ?? 0) + r.n;
        }
        const state: Record<string, number> = {};
        for (const r of stateRows) {
          const st = (r.state ?? "").trim() || "Unknown";
          state[st] = (state[st] ?? 0) + r.n;
        }
        const band: Record<string, number> = {};
        const setBand = (label: string, n: number) => { if (n > 0) band[label] = n; };
        setBand("5 & under", bandRow.b0);
        setBand("6–10", bandRow.b1);
        setBand("11–13", bandRow.b2);
        setBand("14–16", bandRow.b3);
        setBand("17–18", bandRow.b4);
        setBand("19+", bandRow.b5);
        setBand("Unknown", bandRow.unknown);
        out.demographics = { profiled: bandRow.profiled, gender, ageBand: band, state };
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
