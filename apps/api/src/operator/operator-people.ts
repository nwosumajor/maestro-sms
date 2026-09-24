// =============================================================================
// Per-school headcount — ONE grouped query, one definition
// =============================================================================
// The operator console needs "how many students and staff does each school have"
// in four places: the tenant registry, the school directory, a school's profile,
// and the fleet analytics. Before this, each computed it its own way:
//
//   • fleet analytics  — pulled EVERY user_role row for EVERY customer school into
//                        Node and tallied them there, unbounded. At the 5,000-school
//                        target that is tens of millions of rows crossing the wire
//                        to produce a dozen numbers.
//   • school profile   — counted user_role ROWS, not distinct users, so a head
//                        teacher who also teaches counted twice.
//   • fleet analytics  — used a hand-written list of nine staff roles that omitted
//                        warden, driver, head_warden, head_driver, librarian and
//                        junior_admin entirely.
//   • tenant registry  — one `user.count()` per school in a loop, and the answer was
//                        a single lumped figure with students, staff and guardians
//                        added together.
//
// Three answers to one question, two of them wrong in opposite directions. This is
// the one implementation, and `NON_SCHOOL_STAFF_ROLE_NAMES` in @sms/types is the one
// definition — so a role seeded tomorrow is counted without a code change here.
//
// SECURITY: aggregates only. A count is not a roster; no name, no id and no record
// of any individual crosses a tenant boundary. Reaching an actual pupil's record
// still requires impersonation, which is step-up gated and audited by name.
// =============================================================================

import { Prisma } from "@sms/db";
import { NON_SCHOOL_STAFF_ROLE_NAMES, NON_STAFF_ROLE_NAMES } from "@sms/types";
import { inSchoolScope, isEmptyScope, type SchoolScope } from "./operator-fleet";

/** One school's headcount, by category. Categories overlap only where a person
 *  genuinely holds two roles — each figure counts DISTINCT people. */
export interface SchoolHeadcount {
  students: number;
  staff: number;
  parents: number;
}

export const EMPTY_HEADCOUNT: SchoolHeadcount = { students: 0, staff: 0, parents: 0 };

/** Minimal shape we need from a Prisma-like client (the privileged one, or a tx). */
type Queryable = { $queryRaw<T = unknown>(q: TemplateStringsArray | Prisma.Sql, ...v: unknown[]): Promise<T> };

/**
 * Headcount for many schools at once, in ONE query.
 *
 * Each figure counts DISTINCT PEOPLE. A head teacher who also teaches holds two
 * staff roles and is one member of staff; summing per-role counts — the obvious
 * implementation — would report them twice.
 *
 * HOW, AND WHY IN TWO PARTS. `user_role` is UNIQUE on (userId, roleId),
 * enforced by the database, so nobody holds the student role twice or the
 * parent role twice: `count(*)` over those rows already IS the number of
 * distinct people. Only STAFF can hold several roles at once, so only staff are
 * de-duplicated — and separately, over the staff rows alone.
 *
 * This was one query with `count(DISTINCT "userId")` on all three figures. A
 * DISTINCT aggregate makes Postgres sort ITS WHOLE INPUT by (school, user) —
 * even with a FILTER, and even if only one of the three keeps it — and at the
 * 5,000-school / 2.5M-pupil target that sort spilled 41 MB to disk: 3.3 s as a
 * prepared statement, the form the app actually runs. Split, it is 2.1 s, with
 * the same answer for every one of 5,003 schools.
 */
export async function headcountBySchool(
  client: Queryable,
  scope: SchoolScope,
): Promise<Map<string, SchoolHeadcount>> {
  const out = new Map<string, SchoolHeadcount>();
  if (isEmptyScope(scope)) return out;

  // ON ROLL, not ever-enrolled, in BOTH parts. This counted people who had
  // LEFT: exit a pupil and the operator console said 901 while billing charged
  // for 900, which reads as a school being under-billed rather than as two
  // questions being asked. The Prisma call sites were fixed when
  // common/student-scope.ts was written; this raw SQL was missed, and the
  // giveaway was that the constant written for it — ON_ROLL_STUDENT_ROLE_ROW,
  // "expressed against user_role for the cross-tenant fleet sweep" — had no
  // callers at all. Applied to staff and parents too: a departed teacher is not
  // headcount either, and three figures on one screen must answer the same
  // question.
  const onRoll = Prisma.sql`
    FROM user_role ur
    JOIN role r ON r.id = ur."roleId"
    JOIN "user" u ON u.id = ur."userId" AND u.status = 'ACTIVE'
    WHERE ${inSchoolScope(Prisma.sql`ur."schoolId"`, scope)}`;

  const rows = await client.$queryRaw<
    Array<{ schoolId: string; students: number; staff: number; parents: number }>
  >(Prisma.sql`
    WITH families AS (
      SELECT ur."schoolId",
             count(*) FILTER (WHERE r.name = 'student')::int AS students,
             count(*) FILTER (WHERE r.name = 'parent')::int  AS parents
      ${onRoll}
      GROUP BY ur."schoolId"
    ), staff AS (
      SELECT "schoolId", count(*)::int AS staff
      FROM (
        SELECT DISTINCT ur."schoolId", ur."userId"
        ${onRoll}
          AND r.name <> ALL(ARRAY[${Prisma.join([...NON_SCHOOL_STAFF_ROLE_NAMES])}]::text[])
      ) people
      GROUP BY "schoolId"
    )
    -- families groups EVERY on-roll role row, staff included, so it holds
    -- every school with anybody on roll — a school with staff and no pupils
    -- yet is a row with zeros. That is why this can be a LEFT JOIN, and why
    -- families must never be narrowed to pupil and parent rows.
    SELECT f."schoolId",
           f.students,
           COALESCE(s.staff, 0) AS staff,
           f.parents
    FROM families f
    LEFT JOIN staff s ON s."schoolId" = f."schoolId"
  `);

  for (const r of rows) {
    out.set(r.schoolId, { students: r.students, staff: r.staff, parents: r.parents });
  }
  return out;
}

/** The same figures for ONE school, from inside that school's own tenant tx.
 *  Used by the profile drill-down, which is already scoped to the school. */
export async function headcountInTenant(tx: Queryable, schoolId: string): Promise<SchoolHeadcount> {
  return (await headcountBySchool(tx, [schoolId])).get(schoolId) ?? { ...EMPTY_HEADCOUNT };
}

/** Re-exported so callers never hand-roll a staff list again. */
export { NON_SCHOOL_STAFF_ROLE_NAMES, NON_STAFF_ROLE_NAMES };
