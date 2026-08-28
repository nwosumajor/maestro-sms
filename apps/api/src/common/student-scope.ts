// =============================================================================
// "Who is a student?" — three questions, not one
// =============================================================================
// The codebase had ONE definition: holds the `student` role. Ten call sites used
// it, and the comments at several of them proudly said so — "the same definition
// the billing seat count uses, so the three cannot disagree".
//
// That was right while a pupil could never leave. Once `User.status = EXITED`
// existed, the single definition started answering three different questions
// with the same answer, and only one of them was still correct:
//
//   ON ROLL      who is here NOW — billing seats, registers, headcounts,
//                pickers, search. A pupil who left is always wrong here.
//   EVER ENROLLED  who has ever attended — the institutional archive, records
//                exports, transcripts. A pupil who left is always RIGHT here;
//                filtering them out would silently shorten a school's history.
//   MAY SIGN IN  handled in auth, which allowlists ACTIVE.
//
// Most sites want ON ROLL and were silently getting EVER ENROLLED. The one that
// costs money: the seat count a school is BILLED on counted pupils who had left,
// so a school that exited a hundred children went on paying for them.
//
// These are constants rather than a filter copy-pasted per module ON PURPOSE.
// Per-module copies are exactly how the `SCHOOL_WIDE_ROLES` sets drifted apart —
// 26 of them listed super_admin, each copied from the last. One definition, and
// `test/common/student-scope.spec.ts` fails the build if a new call site
// hand-rolls its own.
// =============================================================================

import { Prisma } from "@sms/db";

/** The role every pupil holds. Never type this string at a call site. */
export const STUDENT_ROLE = "student";

/**
 * ON ROLL — a pupil who is here now.
 *
 * Use for: billing seats, registers, headcounts, staff pickers, search,
 * directories, dashboards, consent-coverage denominators. Anywhere the answer
 * feeds a decision about the present.
 */
export const ON_ROLL_STUDENT: Prisma.UserWhereInput = {
  roles: { some: { role: { name: STUDENT_ROLE } } },
  status: "ACTIVE",
};

/**
 * EVER ENROLLED — a pupil who is or was here.
 *
 * Use for: the institutional archive, records/transcript exports, historical
 * reporting. Deliberately unfiltered — a school still owes a leaver their
 * records, and an archive that quietly drops them is worse than no archive.
 */
export const EVER_ENROLLED_STUDENT: Prisma.UserWhereInput = {
  roles: { some: { role: { name: STUDENT_ROLE } } },
};

/**
 * ON ROLL, expressed against `user_role` — for a caller that starts from role
 * rows rather than from users.
 *
 * The fleet headcount is raw SQL and cannot take a Prisma filter, so it carries
 * the same rule inline with a note pointing here. That it went years with NO
 * caller was the tell: the sweep was counting leavers.
 */
export const ON_ROLL_STUDENT_ROLE_ROW: Prisma.UserRoleWhereInput = {
  role: { name: STUDENT_ROLE },
  user: { status: "ACTIVE" },
};

/**
 * IS THIS A PUPIL AT ALL — deliberately without a status filter.
 *
 * A different question from the two above, and the difference is load-bearing.
 * `ON_ROLL_*` answers "who is currently on roll", which is what a headcount and
 * a bill want. This answers "is this user a pupil", which is what a GUARDIAN
 * LINK wants: `parent_child` is the family-scope access table, and a link to a
 * pupil who has since left is legitimate — a leaver keeps their guardians, on
 * the same reasoning that keeps their name on their own past records.
 *
 * Adding `status: ACTIVE` here would refuse a real link, which fails in the
 * direction of "the child has no guardian" — the failure the check exists to
 * prevent. It matches LmsService.linkGuardian, which has always checked the
 * role and not the status; two spellings of one rule is how a pair drifts.
 */
export const IS_STUDENT_ROLE_ROW: Prisma.UserRoleWhereInput = {
  role: { name: STUDENT_ROLE },
};

/**
 * The billed seat count for one school, in SQL.
 *
 * Counts `user` rather than `user_role` so distinct-user semantics live in the
 * database, where a duplicate role assignment cannot inflate a school's bill —
 * and returns a COUNT rather than hydrating rows through the ORM to read
 * `.length`. It runs on the billing screen, every checkout, the true-up quote
 * and the seat top-up, and it scales with the thing that makes a customer
 * valuable, so it is not a cold path.
 */
export function countOnRollStudents(tx: {
  user: { count: (args: { where: Prisma.UserWhereInput }) => Promise<number> };
}): Promise<number> {
  return tx.user.count({ where: ON_ROLL_STUDENT });
}
