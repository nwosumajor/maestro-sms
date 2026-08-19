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
 * `count(DISTINCT "userId")` per category is what makes the staff figure right:
 * a head teacher who also teaches holds two staff roles and is one member of staff.
 * Summing per-role counts — the obvious implementation — would report them twice.
 */
export async function headcountBySchool(
  client: Queryable,
  schoolIds: string[],
): Promise<Map<string, SchoolHeadcount>> {
  const out = new Map<string, SchoolHeadcount>();
  if (schoolIds.length === 0) return out;

  const rows = await client.$queryRaw<
    Array<{ schoolId: string; students: number; staff: number; parents: number }>
  >(Prisma.sql`
    SELECT ur."schoolId",
           count(DISTINCT ur."userId") FILTER (WHERE r.name = 'student')::int AS students,
           count(DISTINCT ur."userId") FILTER (WHERE r.name <> ALL(ARRAY[${Prisma.join([
             ...NON_SCHOOL_STAFF_ROLE_NAMES,
           ])}]::text[]))::int                                                AS staff,
           count(DISTINCT ur."userId") FILTER (WHERE r.name = 'parent')::int  AS parents
    FROM user_role ur
    JOIN role r ON r.id = ur."roleId"
    -- ON ROLL, not ever-enrolled. This counted people who had LEFT: exit a
    -- pupil and the operator console said 901 while billing charged for 900,
    -- which reads as a school being under-billed rather than as two questions
    -- being asked. The Prisma call sites were fixed when common/student-scope.ts
    -- was written; this raw SQL was missed, and the giveaway was that the
    -- constant written for it — ON_ROLL_STUDENT_ROLE_ROW, "expressed against
    -- user_role for the cross-tenant fleet sweep" — had no callers at all.
    --
    -- Applied to staff and parents too: a departed teacher is not headcount
    -- either, and three figures on one screen must answer the same question.
    JOIN "user" u ON u.id = ur."userId" AND u.status = 'ACTIVE'
    WHERE ur."schoolId" = ANY(ARRAY[${Prisma.join(schoolIds)}]::uuid[])
    GROUP BY ur."schoolId"
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
