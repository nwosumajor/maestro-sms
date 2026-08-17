// =============================================================================
// A teacher kept access to pupils who had left their class
// =============================================================================
// Every relationship check of the shape "is this pupil in a class I teach?" was
// written as:
//
//     tx.enrollment.findFirst({ where: { studentId, classId: { in: taught } } })
//
// with no `status`. `enrollment` is a HISTORY — a pupil who withdraws,
// transfers or is promoted keeps their row with a new status — so the question
// the code actually asked was "was this pupil EVER in a class I teach", and the
// answer stays true forever.
//
// Proven against the running stack rather than reasoned about. One pupil, one
// teacher, the pupil's only enrolment in that teacher's only class:
//
//   pupil ACTIVE      -> GET /documents?studentId=…            200, 1 item
//   pupil WITHDRAWN   -> GET /documents?studentId=…            200, 1 item   <-
//                        GET /documents/<id>                   200
//                        GET /documents/<id>/download          200  (signed URL)
//
// A report card for a child who is no longer theirs, downloadable indefinitely.
//
// The same shape appeared in six places: documents (twice — the list expansion
// and the single-record check), SIS profile, attendance, report cards and term
// results. Whole-school staff are unaffected, so a departed pupil's paperwork
// can still be produced by the office — which is what makes narrowing the
// teacher safe rather than merely stricter.
//
// NOT narrowed, deliberately: the SELF and PARENT directions
// (`enrollment.findMany({ studentId: p.userId })` in LMS, timetable and search).
// Those answer "which classes am I, or my child, in" and a family keeping sight
// of its own history is correct — filtering them would take a parent's past
// records away to fix a teacher's excess.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");

/** The teacher-direction checks: "is this pupil in a class I teach?" */
const TEACHER_DIRECTION: Array<[string, string]> = [
  ["documents/documents.service.ts", "assertCanAccessStudent"],
  ["documents/documents.service.ts", "visibleStudentIds"],
  ["sis/sis.service.ts", "assertCanAccessStudent"],
  ["attendance/attendance.service.ts", "assertCanAccessStudent"],
  ["reportcards/reportcard.service.ts", "assertCanAccess"],
  ["gradebook/term-result.service.ts", "canReadReport"],
];

/** Brace-match forward from `open`, returning the balanced span. */
function balanced(src: string, open: number, o = "{", c = "}"): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unterminated");
}

/**
 * The body of the DECLARATION of `name`, not of a call to it.
 *
 * Anchoring on the bare name matched `await this.assertCanAccessStudent(...)`
 * first and returned whatever followed — which contained no enrolment query at
 * all, so the assertion passed vacuously in one direction and failed
 * confusingly in the other. A test that reads the wrong function is worse than
 * no test.
 */
function bodyOf(src: string, name: string): string {
  const decl = new RegExp(`^\\s*(private |protected |public )?(async )?${name}\\s*\\(`, "m");
  const m = decl.exec(src);
  if (!m) throw new Error(`no declaration of ${name}`);
  return balanced(src, src.indexOf("{", src.indexOf(")", m.index + m[0].length - 1)));
}

/** Every `tx.enrollment.findX({...})` in `body`, brace-matched so a nested
 *  object (`classId: { in: [...] }`) does not cut the match short. */
function enrolmentQueries(body: string): string[] {
  const out: string[] = [];
  const re = /\.enrollment\.(findFirst|findMany|count)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(balanced(body, body.indexOf("{", m.index + m[0].length - 1)));
  return out;
}

describe("the six checks that decided a teacher's reach", () => {
  it.each(TEACHER_DIRECTION)("%s › %s asks only about CURRENT enrolment", (file, fn) => {
    const body = bodyOf(SRC(file), fn);
    const queries = enrolmentQueries(body);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect([file, fn, q.includes('status: "ACTIVE"')]).toEqual([file, fn, true]);
    }
  });

  it("still lets whole-school staff reach a pupil who has left", () => {
    // Otherwise the fix would strand a departed pupil's records entirely: the
    // office must still be able to issue a transcript or a final report.
    for (const [file] of TEACHER_DIRECTION) {
      const src = SRC(file);
      expect([file, /isStaffWide|isReadWide|isRosterWide|_WIDE\b|WIDE_ROLES/.test(src)]).toEqual([file, true]);
    }
  });
});

describe("what must NOT be narrowed", () => {
  /** "Which classes am I, or my child, in" — a family's own history. */
  const FAMILY_DIRECTION: Array<[string, string]> = [
    ["lms/lms.service.ts", "visibleClasses"],
    ["timetable/timetable.service.ts", "visibleClassIds"],
    ["search/search.service.ts", "visibleClassIds"],
  ];

  it.each(FAMILY_DIRECTION)("%s › %s still sees a family's whole history", (file, fn) => {
    const body = bodyOf(SRC(file), fn);
    // These query by studentId (self or child), never by "classes I teach".
    expect(body).toMatch(/studentId: p\.userId|studentId: \{ in:/);
    const selfQueries = enrolmentQueries(body).filter((q) => /studentId/.test(q));
    expect(selfQueries.length).toBeGreaterThan(0);
    for (const q of selfQueries) {
      // If someone "fixes" these the same way, a parent loses last year's
      // timetable and their child stops being findable in search.
      expect([file, fn, q.includes('status: "ACTIVE"')]).toEqual([file, fn, false]);
    }
  });
});

describe("the rule, stated once", () => {
  it("is written down where the next person will change it", () => {
    const doc = SRC("documents/documents.service.ts");
    expect(doc).toMatch(/SECURITY: ACTIVE only/);
    expect(doc).toMatch(/withdrawn, transferred or been promoted out/);
  });
});
