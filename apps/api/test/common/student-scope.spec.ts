// =============================================================================
// One definition of "who is a student"
// =============================================================================
// The codebase had a single definition — holds the `student` role — and ten call
// sites using it. That was correct while a pupil could never leave. The moment
// `User.status = EXITED` existed it started answering three different questions
// with one answer, and the expensive one was money: the seat count a school is
// BILLED on counted pupils who had gone.
//
// The failure shape is the one this repo keeps meeting: the writer was added,
// the readers were not, and every half is individually correct so no test can
// see the gap. `SCHOOL_WIDE_ROLES` drifted the same way — 26 per-module copies,
// each cloned from the last, until one of them was wrong.
//
// So the definition lives in ONE place and this guard fails the build when a new
// call site hand-rolls it again.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ON_ROLL_STUDENT, EVER_ENROLLED_STUDENT, countOnRollStudents } from "../../src/common/student-scope";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Sites that deliberately mean EVER ENROLLED, with the reason.
 *
 * An exemption list only works if each entry is a decision someone made, so each
 * is named and justified rather than swept under a pattern.
 */
const EVER_ENROLLED_BY_DESIGN: Record<string, string> = {
  "privacy/archive.service.ts":
    "the institutional archive — a school's history must not silently shorten when a pupil leaves",
  "operator/operator-export.service.ts":
    "a records export, which is exactly what a leaver is entitled to receive",
  "common/student-scope.ts": "the definition itself",
};

describe("the on-roll definition", () => {
  it("means role AND active — the filter that was missing", () => {
    expect(ON_ROLL_STUDENT).toEqual({
      roles: { some: { role: { name: "student" } } },
      status: "ACTIVE",
    });
  });

  it("keeps EVER ENROLLED deliberately unfiltered", () => {
    // Not an oversight. Filtering here would drop leavers out of the archive.
    expect(EVER_ENROLLED_STUDENT).not.toHaveProperty("status");
  });

  it("is not the same object as EVER ENROLLED", () => {
    expect(ON_ROLL_STUDENT).not.toEqual(EVER_ENROLLED_STUDENT);
  });
});

describe("no call site hand-rolls it", () => {
  const files = sourceFiles(join(__dirname, "../../src"));

  it("every student-role query uses the shared scope or is a named exception", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.split("/src/")[1];
      if (EVER_ENROLLED_BY_DESIGN[rel]) continue;
      const src = readFileSync(file, "utf8");
      // The literal role filter, in either Prisma shape.
      for (const m of src.matchAll(/role: \{ name: "student" \}/g)) {
        const line = src.slice(0, m.index ?? 0).split("\n").length;
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Counting pupils through ENROLMENT reaches the same wrong answer by another
   * road.
   *
   * The check above watches for a hand-rolled `role: { name: "student" }`. The
   * school-operations dashboard did not have one — it counted
   * `enrollment.groupBy({ by: ["studentId"] })` and took the length, which is
   * EVER ENROLLED however you dress it, so a school that exited a hundred
   * children went on seeing them in its headcount. A gate that watches one route
   * to a wrong answer is a gate that will meet the other one.
   *
   * An enrolment aggregate is legitimate when the question really is about
   * enrolments (how many places are filled, per class) — so what is refused is
   * specifically counting DISTINCT PUPILS that way.
   */
  const ENROLMENT_HEADCOUNT_OK: Record<string, string> = {
    "privacy/archive.service.ts":
      "The institutional archive is EVER ENROLLED by design — a school still owes a leaver their records.",
  };

  it("no headcount is derived from enrolment rows", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.split("/src/")[1];
      if (ENROLMENT_HEADCOUNT_OK[rel]) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/enrollment\.groupBy\(\s*\{\s*by:\s*\[\s*["']studentId["']\s*\]/g)) {
        const line = src.slice(0, m.index ?? 0).split("\n").length;
        offenders.push(`${rel}:${line} — counts distinct pupils through enrolment (EVER ENROLLED), not ON_ROLL_STUDENT`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the named exceptions still exist, so the list cannot rot", () => {
    // An exemption naming a deleted file would hide a real offender behind it.
    for (const rel of [...Object.keys(EVER_ENROLLED_BY_DESIGN), ...Object.keys(ENROLMENT_HEADCOUNT_OK)]) {
      expect(files.some((f) => f.endsWith(`/src/${rel}`))).toBe(true);
    }
  });
});

describe("the seat count a school is billed on", () => {
  it("counts in SQL rather than hydrating rows to read .length", async () => {
    // Not style. It runs on the billing screen, every checkout, the true-up
    // quote and the seat top-up, and it scales with the number of pupils — the
    // exact thing that grows as a customer becomes valuable.
    const count = jest.fn().mockResolvedValue(7);
    await expect(countOnRollStudents({ user: { count } })).resolves.toBe(7);
    expect(count).toHaveBeenCalledWith({ where: ON_ROLL_STUDENT });
  });

  it("the fleet sweep groups in the DATABASE, not in Node", () => {
    // It hydrated one row per student across every school on a nightly job —
    // over four million objects at 5,000 schools — purely to count them.
    const src = readFileSync(
      join(__dirname, "../../src/billing/billing-dunning.service.ts"),
      "utf8",
    );
    expect(src).toMatch(/count\(DISTINCT ur\."userId"\)/);
    expect(src).not.toMatch(/distinct: \["schoolId", "userId"\]/);
  });
});
