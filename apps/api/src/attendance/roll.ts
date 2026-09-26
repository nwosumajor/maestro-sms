// =============================================================================
// Who was on a class's ROLL on a given day — and the registers a pupil was
// never marked on
// =============================================================================
// ONE rule, used by every question that depends on it:
//   - which pupils a register may mark, and must mark (AttendanceService),
//   - which pupils the register form offers for a past date (the roll route),
//   - how many registers a pupil was on the roll for and never recorded on
//     (the report card, the term summary, the compiled history).
// Three copies of "who was in this class that day" would be right in two places.
//
// A pupil is on class C's roll on day D when their enrolment in C began on or
// before D and had not ended by D:
//     enrolledAt::date <= D  AND  (endedAt IS NULL OR endedAt::date > D)
// The day a pupil moves belongs to the class they moved TO, so a move never
// counts one day twice. `endedAt` is kept by a database trigger (migration
// 20270326000000), so every writer that closes an enrolment is covered.
//
// Days are UTC calendar days, as `@db.Date` is, and as the register's own
// validation has always compared them.
// =============================================================================

import { Prisma } from "@sms/db";
import type { TenantTx } from "../integrity/integrity.foundation";

const DAY_MS = 86_400_000;

function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Prisma `where` for the enrolments on `classId`'s roll on `day`. */
export function onRollWhere(classId: string, day: Date): Prisma.EnrollmentWhereInput {
  const next = new Date(startOfDayUtc(day).getTime() + DAY_MS);
  return {
    classId,
    enrolledAt: { lt: next },
    OR: [{ endedAt: null }, { endedAt: { gte: next } }],
  };
}

/** The pupils on `classId`'s roll on `day`, by name — what a register for that
 *  day must cover. */
export async function rollOn(
  tx: TenantTx,
  classId: string,
  day: Date,
): Promise<Array<{ id: string; name: string }>> {
  const rows = (await tx.enrollment.findMany({
    where: onRollWhere(classId, day),
    select: { student: { select: { id: true, name: true } } },
    orderBy: { student: { name: "asc" } },
  })) as Array<{ student: { id: string; name: string } }>;
  return rows.map((r) => r.student);
}

/**
 * The registers this pupil was on the roll for and has NO mark on — the same
 * rule as `onRollWhere`, in SQL, anti-joined to the pupil's own records.
 * Includes a register the scan desk started that nobody then took: nobody
 * recorded this pupil that day, which is exactly what it counts.
 *
 * `r."date" = s."date"` is redundant logically (a record's date IS its
 * session's) and there for the planner: it is the partition key of
 * attendance_record, so each probe touches one partition.
 */
function unrecordedFrom(
  studentId: string,
  opts: { window?: { from: Date; to: Date }; byTerm?: boolean } = {},
): Prisma.Sql {
  return Prisma.sql`
    FROM "enrollment" e
    JOIN "attendance_session" s
      ON s."classId" = e."classId"
     AND s."date" >= e."enrolledAt"::date
     AND (e."endedAt" IS NULL OR s."date" < e."endedAt"::date)
    ${opts.byTerm ? Prisma.sql`JOIN "term" t ON s."date" >= t."startDate"::date AND s."date" <= t."endDate"::date` : Prisma.empty}
    WHERE e."studentId" = ${studentId}::uuid
      ${opts.window ? Prisma.sql`AND s."date" >= ${opts.window.from}::date AND s."date" <= ${opts.window.to}::date` : Prisma.empty}
      AND NOT EXISTS (
        SELECT 1 FROM "attendance_record" r
        WHERE r."sessionId" = s."id" AND r."studentId" = e."studentId" AND r."date" = s."date"
      )`;
}

/** Unrecorded registers for a pupil, optionally within an inclusive date window. */
export async function unrecordedCount(
  tx: TenantTx,
  studentId: string,
  window?: { from: Date; to: Date },
): Promise<number> {
  const rows = (await tx.$queryRaw(
    Prisma.sql`SELECT count(*)::int AS n ${unrecordedFrom(studentId, { window })}`,
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/** Unrecorded registers per calendar month ("YYYY-MM"), within a window. */
export async function unrecordedByMonth(
  tx: TenantTx,
  studentId: string,
  window: { from: Date; to: Date },
): Promise<Map<string, { n: number; from: Date; to: Date }>> {
  const rows = (await tx.$queryRaw(Prisma.sql`
    SELECT to_char(date_trunc('month', s."date"), 'YYYY-MM') AS key,
           count(*)::int AS n, min(s."date") AS from_date, max(s."date") AS to_date
    ${unrecordedFrom(studentId, { window })}
    GROUP BY 1
  `)) as Array<{ key: string; n: number; from_date: Date; to_date: Date }>;
  return new Map(rows.map((r) => [r.key, { n: r.n, from: r.from_date, to: r.to_date }]));
}

/** Unrecorded registers per TERM, in one query: a day counts for the term whose
 *  dates contain it. A term with no dates contains nothing. */
export async function unrecordedByTerm(tx: TenantTx, studentId: string): Promise<Map<string, number>> {
  const rows = (await tx.$queryRaw(Prisma.sql`
    SELECT t."id" AS term_id, count(*)::int AS n
    ${unrecordedFrom(studentId, { byTerm: true })}
    GROUP BY t."id"
  `)) as Array<{ term_id: string; n: number }>;
  return new Map(rows.map((r) => [r.term_id, r.n]));
}

/**
 * The window a pupil's "this term" attendance is reported over — the CURRENT
 * term's dates, or undefined (all history) when no term is configured, because
 * zero would read as "never attended". One definition, so the student summary
 * and the parent dashboard cannot disagree with each other or the report card.
 */
export async function currentTermWindow(tx: TenantTx): Promise<{ from: Date; to: Date } | undefined> {
  const term = (await tx.term.findFirst({ where: { isCurrent: true }, select: { startDate: true, endDate: true } })) as
    | { startDate: Date | null; endDate: Date | null }
    | null;
  return term?.startDate && term.endDate ? { from: term.startDate, to: term.endDate } : undefined;
}

/** Lifetime unrecorded registers with their first and last day — what a view
 *  paging a pupil's history needs so its window can REACH them. */
export async function unrecordedSpan(
  tx: TenantTx,
  studentId: string,
): Promise<{ n: number; first: Date | null; last: Date | null }> {
  const rows = (await tx.$queryRaw(
    Prisma.sql`SELECT count(*)::int AS n, min(s."date") AS first_day, max(s."date") AS last_day ${unrecordedFrom(studentId)}`,
  )) as Array<{ n: number; first_day: Date | null; last_day: Date | null }>;
  const r = rows[0];
  return { n: r?.n ?? 0, first: r?.first_day ?? null, last: r?.last_day ?? null };
}
