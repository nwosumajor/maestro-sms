// =============================================================================
// AttendanceRollupService — per-term attendance totals, precomputed
// =============================================================================
// The analytics attendance figure scanned every register row in its window.
// Measured at 3,000 pupils: ~180,000 rows for ONE term, 50.6 ms — growing linearly
// with every term a school retains. Five years is ~900,000 rows and roughly a
// quarter of a second, on a page opened constantly.
//
// THE INVARIANT THAT MAKES THIS SAFE: only ENDED terms are rolled up.
// AttendanceService refuses every write to a register dated before the current
// term's start — locked for everyone, no approval path — so an ended term's records
// cannot change and a rollup of them cannot drift. The CURRENT term is always read
// live. There is no cache invalidation here because there is nothing to invalidate.
//
// A rollup that silently disagreed with the registers would be worse than a slow
// page: attendance figures end up in board minutes and government returns.
// =============================================================================

import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
// VALUE import: Prisma.sql/join only resolve as values, not types (CLAUDE.md).
import { Prisma } from "@sms/db";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

/** Totals for one window, whatever produced them. */
export interface AttendanceTotals {
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  ratePct: number | null;
}

/** Where a figure came from — surfaced so a reader can tell live from precomputed. */
export type TotalsSource = "rollup" | "live";

@Injectable()
export class AttendanceRollupService {
  private readonly logger = new Logger("AttendanceRollup");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  /**
   * Roll up every school's ended terms — the nightly sweep.
   *
   * THE THING THIS FIXES: the rollup was built, consumed and never populated.
   * `AttendanceService` reads the table (`useRollup`) and falls through to the
   * live path when it is empty, so the figures were always right — and always
   * computed the slow way, because the only thing that WROTE a rollup was a
   * manual endpoint no screen calls. The table held 0 rows against 173,701
   * attendance records, and this service's own comments described "the daily
   * sweep" as though one existed.
   *
   * Measured on that data: the whole-school term aggregate the rollup replaces
   * is 93 ms, and it is bounded by the school's LIFETIME rather than its size —
   * five years of registers is roughly a quarter of a second on a page senior
   * staff open constantly.
   *
   * Cross-tenant like the progression and dunning sweeps: the school list is a
   * privileged read, each school's work is tenant-scoped, and a school with no
   * management user to attribute the write to is skipped rather than written as
   * SYSTEM (audit_log.actorId is a non-null FK). One school's failure never
   * stops the rest — the worst case is that its figures stay live, which is
   * what they were before this existed.
   */
  async runSweep(): Promise<{ schools: number; terms: number; skipped: number }> {
    const client = this.privileged.client;
    if (!client) {
      this.logger.warn("Rollup sweep requested but no privileged DB — skipping.");
      return { schools: 0, terms: 0, skipped: 0 };
    }
    const schools = await client.school.findMany({ where: { isPlatform: false }, select: { id: true } });
    let terms = 0;
    let skipped = 0;
    let touched = 0;
    for (const s of schools) {
      const actor = await client.userRole.findFirst({
        where: { schoolId: s.id, role: { name: { in: ["principal", "school_admin"] } } },
        select: { userId: true },
      });
      if (!actor) {
        skipped++;
        continue;
      }
      try {
        const r = await this.refreshEndedTerms({
          schoolId: s.id,
          userId: actor.userId,
          roles: [],
          permissions: [],
        });
        if (r.refreshed.length > 0) touched++;
        terms += r.refreshed.length;
        skipped += r.skipped;
      } catch (err) {
        skipped++;
        this.logger.warn(`rollup sweep failed for school ${s.id}: ${String(err)}`);
      }
    }
    return { schools: touched, terms, skipped };
  }

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** LATE and EXCUSED count as attending — the pupil was in school, or their absence
   *  was authorised. Counting them against attendance would understate it and
   *  contradict the report card, which uses the same rule. */
  private rate(t: { present: number; late: number; excused: number; total: number }): number | null {
    return t.total > 0 ? Math.round(((t.present + t.late + t.excused) / t.total) * 100) : null;
  }

  /**
   * Recompute one term's rollup from the registers, in ONE grouped statement.
   *
   * Refuses a term that has not ended. Rolling up a live term would produce a figure
   * that is wrong by tomorrow and carries no marker saying so — exactly the silent
   * staleness this design exists to avoid.
   */
  async refreshTerm(p: Principal, termId: string): Promise<{ rows: number; termName: string }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const term = (await tx.term.findFirst({
        where: { id: termId },
        select: { id: true, name: true, startDate: true, endDate: true },
      })) as { id: string; name: string; startDate: Date | null; endDate: Date | null } | null;
      if (!term) throw new NotFoundException("Term not found");
      if (!term.startDate || !term.endDate) {
        throw new BadRequestException("That term has no start/end date, so its window is undefined");
      }
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      if (term.endDate >= today) {
        throw new BadRequestException(
          "That term has not ended — a live term is always computed from the registers, never rolled up",
        );
      }

      // Replace outright: a recompute must not leave rows for pupils who have since
      // been unenrolled from the class.
      await tx.attendanceTermRollup.deleteMany({ where: { termId } });

      // ONE statement: group the term's records by (class, student, status) and
      // pivot the four statuses into columns. No rows cross into Node.
      const inserted = await tx.$executeRaw`
        INSERT INTO attendance_term_rollup
          ("id","schoolId","termId","classId","studentId","present","absent","late","excused","total","computedAt")
        SELECT gen_random_uuid(), ${p.schoolId}::uuid, ${termId}::uuid, s."classId", r."studentId",
               count(*) FILTER (WHERE r.status = 'PRESENT')::int,
               count(*) FILTER (WHERE r.status = 'ABSENT')::int,
               count(*) FILTER (WHERE r.status = 'LATE')::int,
               count(*) FILTER (WHERE r.status = 'EXCUSED')::int,
               count(*)::int,
               now()
        FROM attendance_record r
        JOIN attendance_session s ON s.id = r."sessionId"
        WHERE r."schoolId" = ${p.schoolId}::uuid
          AND s.date BETWEEN ${term.startDate}::date AND ${term.endDate}::date
        GROUP BY s."classId", r."studentId"
      `;

      await this.audit.record(
        {
          actorId: p.userId,
          action: "attendance.rollup.refresh",
          entity: "term",
          entityId: termId,
          schoolId: p.schoolId,
          metadata: { term: term.name, rows: inserted },
        },
        tx,
      );
      return { rows: inserted, termName: term.name };
    });
  }

  /**
   * Roll up every ended term that does not have one yet.
   *
   * Idempotent and cheap to re-run: a term already rolled up is skipped, so the
   * daily sweep only ever does work the first time a term ends.
   */
  async refreshEndedTerms(p: Principal): Promise<{ refreshed: string[]; skipped: number }> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const pending = await this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const ended = (await tx.term.findMany({
        where: { endDate: { lt: today }, startDate: { not: null } },
        select: { id: true, name: true },
        orderBy: { endDate: "desc" },
      })) as Array<{ id: string; name: string }>;
      if (ended.length === 0) return [] as Array<{ id: string; name: string }>;
      // One grouped read tells us which of them are already done.
      const done = (await tx.attendanceTermRollup.groupBy({
        by: ["termId"],
        where: { termId: { in: ended.map((t) => t.id) } },
        _count: { _all: true },
      } as never)) as unknown as Array<{ termId: string }>;
      const have = new Set(done.map((d) => d.termId));
      return ended.filter((t) => !have.has(t.id));
    });

    const refreshed: string[] = [];
    for (const t of pending) {
      try {
        await this.refreshTerm(p, t.id);
        refreshed.push(t.name);
      } catch (err) {
        // One bad term must not stop the rest; the figure simply stays live for it.
        this.logger.warn(`rollup skipped for term ${t.id}: ${String(err)}`);
      }
    }
    return { refreshed, skipped: pending.length - refreshed.length };
  }

  /**
   * Attendance totals for a window, reading the rollup when it is provably valid.
   *
   * The rollup is used ONLY when the window is exactly an ended term. Any other
   * window — the current term, an arbitrary date range — is computed live, because
   * a precomputed number that does not match the dates asked for is just a wrong
   * number delivered quickly.
   */
  async totalsFor(
    p: Principal,
    window: { termId: string | null; from: Date; to: Date },
    scope?: { studentIds?: string[]; classId?: string },
  ): Promise<AttendanceTotals & { source: TotalsSource }> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      if (window.termId) {
        const term = (await tx.term.findFirst({
          where: { id: window.termId },
          select: { endDate: true },
        })) as { endDate: Date | null } | null;
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const ended = !!term?.endDate && term.endDate < today;
        if (ended) {
          const agg = (await tx.attendanceTermRollup.aggregate({
            where: {
              termId: window.termId,
              ...(scope?.classId ? { classId: scope.classId } : {}),
              ...(scope?.studentIds ? { studentId: { in: scope.studentIds } } : {}),
            },
            _sum: { present: true, absent: true, late: true, excused: true, total: true },
          } as never)) as unknown as {
            _sum: { present: number | null; absent: number | null; late: number | null; excused: number | null; total: number | null };
          };
          // A rolled-up term with zero rows means the term genuinely had no
          // registers; fall through to live only if the rollup is ABSENT, which
          // refreshEndedTerms has not got to yet.
          const anyRow = await tx.attendanceTermRollup.findFirst({ where: { termId: window.termId }, select: { id: true } });
          if (anyRow) {
            const t = {
              present: agg._sum.present ?? 0,
              absent: agg._sum.absent ?? 0,
              late: agg._sum.late ?? 0,
              excused: agg._sum.excused ?? 0,
              total: agg._sum.total ?? 0,
            };
            return { ...t, ratePct: this.rate(t), source: "rollup" as const };
          }
        }
      }
      return { ...(await this.liveTotals(tx, p, window, scope)), source: "live" as const };
    });
  }

  /** The unrolled path: group the registers themselves. */
  private async liveTotals(
    tx: TenantTx,
    p: Principal,
    window: { from: Date; to: Date },
    scope?: { studentIds?: string[]; classId?: string },
  ): Promise<AttendanceTotals> {
    const studentFilter = scope?.studentIds?.length
      ? Prisma.sql`AND r."studentId" = ANY(ARRAY[${Prisma.join(scope.studentIds)}]::uuid[])`
      : Prisma.sql``;
    const classFilter = scope?.classId ? Prisma.sql`AND s."classId" = ${scope.classId}::uuid` : Prisma.sql``;

    const rows = (await tx.$queryRaw`
      SELECT count(*) FILTER (WHERE r.status = 'PRESENT')::int AS present,
             count(*) FILTER (WHERE r.status = 'ABSENT')::int  AS absent,
             count(*) FILTER (WHERE r.status = 'LATE')::int    AS late,
             count(*) FILTER (WHERE r.status = 'EXCUSED')::int AS excused,
             count(*)::int                                     AS total
      FROM attendance_record r
      JOIN attendance_session s ON s.id = r."sessionId"
      WHERE r."schoolId" = ${p.schoolId}::uuid
        AND s.date BETWEEN ${window.from}::date AND ${window.to}::date
        ${studentFilter}
        ${classFilter}
    `) as Array<{ present: number; absent: number; late: number; excused: number; total: number }>;

    const t = rows[0] ?? { present: 0, absent: 0, late: 0, excused: 0, total: 0 };
    return { ...t, ratePct: this.rate(t) };
  }
}
