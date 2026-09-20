// =============================================================================
// COUNT THE DOORS: every write that puts a subject's name on something
// =============================================================================
// `teachesSubjectInClass` is the one definition of "is this offering mine", and
// `a-subject-rule-written-once` fails on a second hand-rolled copy of it. That
// gate is necessary and it is not sufficient, because it asks a question about
// SPELLING and this defect is about COVERAGE — and it proved that on its first
// outing: it asserts that `lms-content.service.ts` calls the shared rule, the
// file did call it, and `updateLiveSession` in that same file wrote `subjectId`
// with no check at all. A file-level assertion vouched for a door inside it.
//
// The measured shape, twice over. `lmsLiveSession.subjectId` had TWO writers
// and one was guarded: create refused a Maths teacher scheduling the class's
// Physics lesson, while update let them schedule it untagged and PATCH the
// subject on a moment later, for the identical outcome one request afterwards.
// `lmsContent.subjectId` had FOUR — create, update, clone and copy-to-arms —
// and the last two were found only by listing them: cloning carries
// `src.subjectId` when the target is the same class, so a Maths teacher could
// not CREATE a Physics lesson but could clone the Physics teacher's and own the
// copy; copy-to-arms carries it onto every sibling arm the caller can author.
//
// So this gate does not read the call graph and does not trust a filename. It
// COMPUTES the set of methods that write `subjectId` onto either table and
// requires each one to consult the shared rule. That is the same remedy the
// class-capacity work landed on after "all three" writers turned out to be
// seven, and it is the only version that still works once everybody who
// remembers this has moved on.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

const FILE = join(__dirname, "../../src/lms/lms-content.service.ts");

/** The tables where a `subjectId` is a CLAIM about whose subject it is. */
const TAGGED_TABLES = ["lmsContent", "lmsLiveSession"];
/** The one rule, in either of its two shapes (throwing, and the boolean the
 *  per-arm loop needs so it can skip rather than abort halfway). */
const THE_RULE = /\b(assertMayUseSubject|mayUseSubject)\s*\(/;

/**
 * Split a class body into methods.
 *
 * // GOTCHA this repo has already paid for: taking "the first `{` after the
 * // method name" reads the RETURN TYPE on a signature like
 * // `): Promise<{ rows: … }> {`, and the gate then scans a type instead of a
 * // body. Splitting on the NEXT member declaration avoids brace-matching
 * // altogether — every member of this class is declared at exactly one indent.
 */
function methodsOf(src: string): Array<{ name: string; body: string }> {
  const lines = src.split("\n");
  const starts: Array<{ name: string; line: number }> = [];
  const decl = /^ {2}(?:(?:private|public|protected|static|readonly|async)\s+)*([A-Za-z_$][\w$]*)\s*[(<]/;
  const notAMethod = new Set(["if", "for", "while", "switch", "catch", "return", "constructor"]);
  lines.forEach((l, i) => {
    const m = decl.exec(l);
    if (m && !notAMethod.has(m[1])) starts.push({ name: m[1], line: i });
  });
  return starts.map((s, i) => ({
    name: s.name,
    body: lines.slice(s.line, i + 1 < starts.length ? starts[i + 1].line : lines.length).join("\n"),
  }));
}

/** Does this method write a `subjectId` onto one of the tagged tables? */
function writesASubjectTag(body: string): boolean {
  const writes = new RegExp(`\\btx\\.(?:${TAGGED_TABLES.join("|")})\\.(?:create|createMany|update|updateMany|upsert)\\b`);
  if (!writes.test(body)) return false;
  // `data.subjectId = …` (the PATCH shape) or `subjectId:` inside the payload.
  return /\bsubjectId\s*[:=]/.test(body);
}

describe("every door that tags a subject", () => {
  const src = stripComments(readFileSync(FILE, "utf8"));
  const methods = methodsOf(src);

  it("found the methods at all", () => {
    // A split that finds nothing must not pass. Named anchors, not a count:
    // a bare number rots the moment a method is added.
    const names = methods.map((m) => m.name);
    expect(methods.length).toBeGreaterThan(40);
    for (const anchor of ["createContent", "updateContent", "createLiveSession", "updateLiveSession"]) {
      expect([anchor, names.includes(anchor)]).toEqual([anchor, true]);
    }
  });

  it("found the doors, and there are more of them than anyone remembers", () => {
    const doors = methods.filter((m) => writesASubjectTag(m.body)).map((m) => m.name);
    // The detector itself must not be able to rot into matching nothing.
    expect(doors.length).toBeGreaterThanOrEqual(4);
    expect(doors).toEqual(expect.arrayContaining(["createLiveSession", "updateLiveSession"]));
  });

  it("every one of them consults the shared rule", () => {
    const offenders = methods
      .filter((m) => writesASubjectTag(m.body))
      .filter((m) => !THE_RULE.test(m.body))
      .map((m) => m.name);
    // Naming them is the point: the failure has to be actionable without
    // anybody re-deriving which rule this is about.
    expect(offenders).toEqual([]);
  });
});
