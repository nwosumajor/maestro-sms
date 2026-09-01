import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";
import { groupQuestionsBySubject, examTitleFor } from "../../src/scholarship/scholarship-admin.service";

/**
 * §3: a scholarship examined in MORE THAN ONE SUBJECT.
 *
 * The subjects are DERIVED from the questions — each may name one — rather than
 * kept in a second list. So a paper can never exist with nothing on it, a
 * subject can never be silently dropped, and there is no other list for either
 * to fall out of step with.
 *
 * A question naming no subject belongs to the programme's own category, which
 * is exactly the single-paper behaviour this generalises: every programme
 * authored before now produces the one paper it always did.
 */

const src = (...p: string[]) => stripComments(readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8"));
const ADMIN = src("apps", "api", "src", "scholarship", "scholarship-admin.service.ts");
const SERVICE = src("apps", "api", "src", "scholarship", "scholarship.service.ts");
const PORTAL = src("apps", "web", "components", "scholarship", "ScholarshipPortal.tsx");
const OPERATOR = src("apps", "web", "components", "operator", "ScholarshipAdmin.tsx");

describe("papers are derived from the questions", () => {
  it("groups by subject, in first-appearance order", () => {
    const out = groupQuestionsBySubject(
      [{ subject: "Maths" }, { subject: "English" }, { subject: "Maths" }],
      "CATEGORY",
    );
    expect(out.map((p) => p.subject)).toEqual(["Maths", "English"]);
    expect(out[0].questions).toHaveLength(2);
  });

  it("puts an unlabelled question on the programme's own paper", () => {
    // The single-subject behaviour, unchanged.
    const out = groupQuestionsBySubject([{ subject: null }, {}], "MATHEMATICS");
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe("MATHEMATICS");
  });

  it("treats blank and whitespace as unlabelled, not as a paper of their own", () => {
    const out = groupQuestionsBySubject([{ subject: "  " }, { subject: "Maths" }], "CATEGORY");
    expect(out.map((p) => p.subject)).toEqual(["CATEGORY", "Maths"]);
  });

  it("leaves a single-paper exam titled EXACTLY as it always was", () => {
    // Renaming would orphan every exam already announced, because the
    // idempotent lookup keys on the title.
    expect(examTitleFor("Prog", "Maths", 1)).toBe("Scholarship exam — Prog");
    expect(examTitleFor("Prog", "Maths", 2)).toBe("Scholarship exam — Prog (Maths)");
  });
});

describe("one exam per paper, per school", () => {
  it("loops the papers inside the schools", () => {
    expect(ADMIN).toMatch(/for \(const paper of papers\) \{/);
  });

  it("keys idempotency on the PAPER, not just the programme", () => {
    // Keying on (programme, school) alone was right while a programme had one
    // paper, and would have made every subject after the first collide with the
    // one before it.
    expect(ADMIN).toMatch(/where: \{ schoolId, scholarshipProgramId: programId, title \}/);
  });

  it("resolves the SUBJECT from the paper, not the programme category", () => {
    expect(ADMIN).toMatch(/const subjectName = paper\.subject\.replaceAll/);
    expect(ADMIN).toMatch(/scholarshipSubjectConcept\(paper\.subject\)/);
  });

  it("gives each paper its own window, falling back to the programme's", () => {
    expect(ADMIN).toMatch(/const windowFor = \(subject: string\)/);
    expect(ADMIN).toMatch(/own\?\.examAt \? new Date\(own\.examAt\) : program\.examAt!/);
  });
});

describe("a candidate can tell the papers apart", () => {
  it("lists them without opening one, because opening starts a clock", () => {
    expect(SERVICE).toMatch(/async examPapers\(/);
    expect(SERVICE).toMatch(/open: now >= e\.startAt && now <= e\.endAt/);
  });

  it("resolves their sittings in ONE query, not one per paper", () => {
    expect(SERVICE).toMatch(/examId: \{ in: exams\.map\(\(e\) => e\.id\) \}, studentId: p\.userId/);
  });

  it("refuses an unnamed paper when there are several", () => {
    // Starting whichever the database returned first is a candidate sitting the
    // wrong exam.
    expect(SERVICE).toMatch(/several papers — choose which one to sit/);
  });

  it("checks a named paper belongs to THIS programme", () => {
    // Otherwise any exam id would open a paper that is not theirs.
    expect(SERVICE).toMatch(/const match = exams\.find\(\(e\) => e\.id === examId\)/);
  });

  it("shows one button per paper, disabled with the reason", () => {
    expect(PORTAL).toMatch(/papers\.map\(\(paper\) => \(/);
    expect(PORTAL).toMatch(/Opens \$\{dateTime\(paper\.startAt\)\}/);
    expect(PORTAL).toMatch(/You have already sat this paper/);
  });

  it("does not read a failed papers fetch as 'no papers'", () => {
    // That would tell a candidate there is nothing to sit on the morning of
    // their exam.
    expect(PORTAL).toMatch(/setPapers\(res\.ok \?/);
  });
});

describe("scoring across papers", () => {
  it("keeps every exam a school has, not just the last", () => {
    // This was a Map<schoolId, examId>, which silently kept whichever paper
    // came last and scored every candidate on that one alone.
    expect(ADMIN).toMatch(/const examsOfSchool = new Map<string, string\[\]>\(\)/);
  });

  it("averages the papers they SAT, never counting an unsat one as zero", () => {
    // Collect runs whenever the operator presses it — including between two
    // sittings on different days.
    expect(ADMIN).toMatch(/if \(pcts\.length === 0\) continue;/);
    expect(ADMIN).toMatch(/pcts\.reduce\(\(a, b\) => a \+ b, 0\) \/ pcts\.length/);
  });
});

describe("editing a paper does not scatter it", () => {
  it("carries the subject back on a removal", () => {
    // The removal REPLACES the whole set, so a field dropped there is dropped
    // from every question that survives — removing one question would have
    // collapsed a three-paper exam into one, silently.
    expect(OPERATOR).toMatch(/\.map\(\(\{ text, options, answerIndex, subject \}\) => \(\{ text, options, answerIndex, subject \}\)\)/);
  });

  it("keeps the subject between questions while authoring", () => {
    // A paper is authored a question at a time; re-typing the subject for each
    // is how half of them end up on the wrong paper.
    // Anchored on the PROPERTY, not on the option list: this asserted the
    // literal four-option reset and went red when the composer gained option E
    // — a fixed-text assertion firing on an improvement, which this repo keeps
    // recording. What matters is that the QUESTION is cleared and the SUBJECT
    // is not.
    expect(OPERATOR).toMatch(/setQ\(\{ text: "",(?: [a-e]: "",)+ answer: 0 \}\)/);
    const add = OPERATOR.slice(OPERATOR.indexOf("const addQ = () =>"));
    expect(add.slice(0, 600)).not.toMatch(/setSubject\(""\)/);
  });
});
