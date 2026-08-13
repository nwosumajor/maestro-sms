// =============================================================================
// One school, one grading policy — everywhere
// =============================================================================
// A school can set its own component weights and its own letter bands
// (`school.gradingPolicy`, edited on /admin/academic). The WRITE path honoured
// it. Almost nothing else did.
//
// `recomputeTotal(row, policy?)` took the policy as an OPTIONAL parameter and
// not one of its four callers passed it, so every READ recomputed on the
// platform defaults: the teacher's roster, the broadsheet, the session report
// and the report card. The comment above it claimed the opposite — "everything a
// family reads comes through here, so one thread carries it" — which is how it
// survived: the design was right and only the wiring was missing, and the
// wiring is invisible in a diff.
//
// The same defect had spread by copying:
//   • the report card derived the OVERALL term letter with `gradeLetter(avg)`
//     and no bands, so subject grades used the school's scale and the average
//     beneath them used the platform's — on one page, a family reads both;
//   • CLASS POSITION ranked classmates on platform weights while printing a
//     school-weighted average, so the two numbers on that page were on
//     different scales and could disagree about who did better;
//   • CBT scaled every pushed exam mark to the platform's /60 — a school
//     weighting its exam /70 capped every candidate ten marks short;
//   • the LMS assignment push did the same;
//   • the grading console PREVIEWED each total in the browser on platform
//     weights while the server saved on the school's, so the number the teacher
//     watched was not the number that got stored;
//   • the controller's Zod schema capped each mark at the PLATFORM maximum
//     ahead of the service's policy-aware check, so a school that had raised
//     its exam to /70 could not enter 65 at all;
//   • the scholarship merit signal — read by a reviewer deciding an award —
//     was computed on platform weights and so disagreed with the pupil's own
//     report card.
//
// Every one of these is silent. Nothing errors; the numbers are simply computed
// against a policy the school did not choose. So the test that matters is not
// any single case — it is that no production call site omits the policy again.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { computeTermSubjectGrade, gradeLetter, GRADE_COMPONENTS } from "@sms/types";

const API_SRC = join(__dirname, "../../src");
const WEB_SRC = join(__dirname, "../../../web");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
    const f = join(dir, entry);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.tsx?$/.test(entry) && !/\.spec\.ts$|\.test\.tsx?$/.test(entry)) out.push(f);
  }
  return out;
}

/** Call sites of `fn(` with only ONE argument — i.e. no policy passed. */
function unparameterisedCalls(fn: string, files: string[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // The grading module itself defines the defaults; it is allowed to use them.
    if (f.endsWith("grading.ts")) continue;
    let i = src.indexOf(`${fn}(`);
    while (i !== -1) {
      const before = src[i - 1] ?? "";
      if (/[A-Za-z0-9_$.]/.test(before)) {
        i = src.indexOf(`${fn}(`, i + 1);
        continue; // part of a longer identifier, or a method on something else
      }
      // Walk the argument list, tracking nesting, and count top-level commas.
      let depth = 0;
      let commas = 0;
      let j = i + fn.length;
      for (; j < src.length; j++) {
        const ch = src[j];
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        else if (ch === ")" || ch === "}" || ch === "]") {
          depth--;
          if (depth === 0) break;
        } else if (ch === "," && depth === 1) commas++;
      }
      if (commas === 0) {
        const line = src.slice(0, i).split("\n").length;
        hits.push(`${f.replace(/.*\/(apps\/)/, "$1")}:${line}`);
      }
      i = src.indexOf(`${fn}(`, j);
    }
  }
  return hits;
}

describe("the guard finds a call that drops the policy", () => {
  // Validating the detector against a KNOWN-bad shape, so a green result below
  // means the scan works rather than that it matched nothing.
  it("flags a single-argument call and not a two-argument one", () => {
    const dir = join(__dirname, "__fixture__");
    const files = [join(dir, "bad.ts")];
    jest.spyOn(require("node:fs"), "readFileSync").mockImplementation(((p: string) =>
      String(p).endsWith("bad.ts")
        ? "gradeLetter(avg);\ngradeLetter(avg, bands);\n"
        : readFileSync(p, "utf8")) as never);
    const hits = unparameterisedCalls("gradeLetter", files);
    jest.restoreAllMocks();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/:1$/);
  });
});

describe("no production code computes a grade on the platform's defaults", () => {
  const apiFiles = walk(API_SRC);
  const webFiles = [
    join(WEB_SRC, "components/gradebook/GradingConsole.tsx"),
    ...walk(join(WEB_SRC, "components/cbt")),
  ].filter((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });
  const files = [...apiFiles, ...webFiles];

  it("every computeTermSubjectGrade call is given the school's components", () => {
    expect(unparameterisedCalls("computeTermSubjectGrade", files)).toEqual([]);
  });

  it("every gradeLetter call is given the school's bands", () => {
    // This is the one the report card got wrong: the overall term grade a
    // family reads was on a different scale from the subject grades above it.
    expect(unparameterisedCalls("gradeLetter", files)).toEqual([]);
  });
});

describe("the read paths agree with the write path", () => {
  const src = readFileSync(join(API_SRC, "gradebook/term-result.service.ts"), "utf8");

  it("recomputeTotal is never called without a policy", () => {
    // The original defect, exactly: four callers, an optional parameter, and
    // nobody passing it.
    expect(src).not.toMatch(/recomputeTotal\([A-Za-z0-9_.]+\)/);
  });

  it("the roster carries the school's policy to the browser", () => {
    // So the console's live preview cannot drift from what the save stores:
    // there is no second source for it to fall out of step with.
    expect(src).toMatch(/components: grading\.components\.map/);
    expect(src).toMatch(/bands: \[\.\.\.resolveGradeBands\(grading\)\]/);
  });

  it("the term report states the average's LETTER, rather than leaving it derived", () => {
    expect(src).toMatch(/averageGrade: avg !== null \? gradeLetter\(avg, resolveGradeBands\(policy\)\) : null/);
  });
});

describe("the report card takes the letter it is given", () => {
  const src = readFileSync(join(API_SRC, "reportcards/reportcard.service.ts"), "utf8");

  it("uses the term report's averageGrade instead of recomputing", () => {
    expect(src).toMatch(/termGrade = tr\?\.averageGrade \?\? null/);
  });

  it("ranks the class on the school's weighting", () => {
    expect(src).toMatch(/grading\?\.components,/);
  });
});

describe("pushed marks scale to the school's maximum", () => {
  it("CBT scales to the school's exam component", () => {
    const src = readFileSync(join(API_SRC, "cbt/cbt.service.ts"), "utf8");
    expect(src).toMatch(/const \{ examMax \} = plan;/);
    expect(src).toMatch(/grading\.components\.find\(\(c: \{ key: string; max: number \}\) => c\.key === "exam"\)/);
  });

  it("the LMS assignment push scales to the school's assignment component", () => {
    const src = readFileSync(join(API_SRC, "lms/lms-content.service.ts"), "utf8");
    expect(src).toMatch(/roster\.components\.find\(\(c\) => c\.key === "assignment"\)\?\.max/);
  });
});

describe("the boundary does not refuse a mark the school allows", () => {
  const src = readFileSync(join(API_SRC, "gradebook/gradebook.controller.ts"), "utf8");

  it("no longer caps each component at the PLATFORM maximum", () => {
    // The service knows the school's ceiling and names it in the error; the
    // controller's job is only to reject something that is not a sane mark.
    expect(src).not.toMatch(/max\(gradeComponentMax\(/);
    expect(src).toMatch(/z\.number\(\)\.min\(0\)\.max\(GRADE_TOTAL_MAX\)/);
  });
});

describe("what a custom policy actually changes", () => {
  // The behaviour underneath all of the above, so this suite is not purely a
  // source scan: with different weights the SAME marks give a different total.
  const CUSTOM = [
    { key: "exam", label: "Exam", max: 70 },
    { key: "midterm", label: "Midterm test", max: 10 },
    { key: "assignment", label: "Assignment", max: 10 },
    { key: "classNote", label: "Class note", max: 10 },
  ] as const;

  it("a mark legal under the school's policy is illegal under the platform's", () => {
    const marks = { exam: 65, midterm: 8, assignment: 8, classNote: 9 };
    expect(computeTermSubjectGrade(marks, CUSTOM).total).toBe(90);
    // Under the platform's /60 exam the same 65 is over the maximum — which is
    // precisely why the controller must not be the one enforcing the ceiling.
    expect(GRADE_COMPONENTS.find((c) => c.key === "exam")!.max).toBe(60);
  });

  it("custom BANDS move the letter for an unchanged total", () => {
    const strict = [
      { min: 80, grade: "A" },
      { min: 65, grade: "B" },
      { min: 0, grade: "F" },
    ];
    expect(gradeLetter(70)).toBe("A"); // platform default
    expect(gradeLetter(70, strict)).toBe("B"); // the school's own scale
  });
});

// =============================================================================
// A permission whose rows are all 404
// =============================================================================
// `grade.read` is seeded to board, head_teacher, junior_admin, principal,
// school_admin, teacher, student and parent. The gradebook's row scope was
// `new Set(["school_admin"])` — one name — so a principal, who signs the report
// cards, could not open the broadsheet those grades come from, and neither
// could the head teacher who approves them. Not a 403 either: a 404, which
// reads as "no such class" rather than "not for you".
//
// It could not simply be widened, because ONE set gated both reading and
// writing: adding `board` — read-only oversight, by definition — would have
// handed them grade WRITING. That is why the read grants had been left dead
// instead of honoured. So the sets are now two, and the split is the point.
// =============================================================================

describe("who can read a class's marks, and who can change them", () => {
  const src = readFileSync(join(API_SRC, "gradebook/term-result.service.ts"), "utf8");

  it("the principal is school-wide for grading, as everywhere else in the platform", () => {
    expect(src).toMatch(/const SCHOOL_WIDE_ROLES = new Set\(\["school_admin", "principal"\]\)/);
  });

  it("read scope is a SEPARATE, wider set", () => {
    expect(src).toMatch(/const READ_WIDE_ROLES = new Set\(\[\.\.\.SCHOOL_WIDE_ROLES, "board", "head_teacher", "junior_admin"\]\)/);
  });

  it("the read-only roles are NOT in the write set", () => {
    // The whole reason for two sets. If this ever collapses back to one,
    // read-only oversight silently becomes write access to grades.
    const writeSet = src.match(/const SCHOOL_WIDE_ROLES = new Set\(\[([^\]]*)\]\)/)![1];
    for (const readOnly of ["board", "head_teacher", "junior_admin"]) {
      expect(writeSet).not.toContain(readOnly);
    }
  });

  it("the two READ scopes use the read set and nothing else does", () => {
    // canReadReport + canViewClass. The grading gate (canGradeClassSubject)
    // must keep using the narrow one.
    expect(src.match(/if \(this\.isReadWide\(p\)\) return true;/g) ?? []).toHaveLength(2);
    expect(src).toMatch(/\/\*\* School-wide for READS only\. Never call this on a write path\. \*\//);
  });
});
