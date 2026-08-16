// =============================================================================
// What the report card actually PRINTS
// =============================================================================
// Every other test around report cards checks the numbers going in. None of them
// had ever read the page coming out — and that gap hid a real defect: the skills
// and behaviour block, and the term total beneath it, were nested inside
// `if (remarks)`. A card with twenty behavioural ratings and no teacher's remark
// printed neither, silently, and the ratings looked saved because they were.
//
// So this suite renders the PDF and reads the text back. PDFKit deflates its
// content streams, so the text is inflated out of them first. It is slower than
// asserting on the source, and it is the only kind of check that can tell the
// difference between "the code runs" and "the parent sees it".
// =============================================================================

import zlib from "node:zlib";
import { GRADE_SCALES, TRAIT_GROUPS } from "@sms/types";
import { ReportCardService } from "../../src/reportcards/reportcard.service";

/**
 * Pull the visible text out of a PDFKit document.
 *
 * Content streams are Flate-compressed; inside them PDFKit writes each run as a
 * hex string in a TJ array — `[<416461> 0] TJ` — one byte per character for the
 * standard Helvetica the report card uses.
 */
function textOf(pdf: Buffer): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const s = pdf.indexOf("\nstream", i);
    if (s === -1) break;
    let from = s + 7;
    while (pdf[from] === 0x0d || pdf[from] === 0x0a) from += 1;
    const e = pdf.indexOf("endstream", from);
    if (e === -1) break;
    i = e + 9;
    let raw: string;
    try {
      raw = zlib.inflateSync(pdf.subarray(from, e)).toString("latin1");
    } catch {
      continue; // not a deflated content stream (fonts, images)
    }
    // PDFKit splits a single line into several hex runs wherever the font
    // kerns, so the runs must be glued back together or "First Term" reads as
    // "First", "T", "er", "m" and no substring assertion can ever match. A `Tm`
    // sets a new text position — that, not a run boundary, is where a line ends.
    for (const chunk of raw.split(/\bTm\b/)) {
      const line = [...chunk.matchAll(/<([0-9A-Fa-f]+)>/g)]
        .map((m) => Buffer.from(m[1], "hex").toString("latin1"))
        .join("");
      // WinAnsi puts the dashes, curly quotes and the ellipsis where latin1 has
      // control codes.
      if (line) {
        out.push(
          line
            .replace(/\x97/g, "—")
            .replace(/\x96/g, "–")
            .replace(/\x92/g, "’")
            .replace(/\x85/g, "…"),
        );
      }
    }
  }
  return out.join("\n");
}

const BASE = {
  studentName: "Ada Obi",
  schoolName: "St Andrews",
  admissionNumber: "ADM-1",
  className: "JSS1",
  termName: "First Term",
  subjects: [
    { subjectId: "s1", subjectName: "Mathematics", exam: 50, midterm: 15, assignment: 8, classNote: 8, total: 81, grade: "A", complete: true, position: 1, subjectRanked: 10 },
    { subjectId: "s2", subjectName: "English", exam: 40, midterm: 12, assignment: 7, classNote: 6, total: 65, grade: "B", complete: true, position: 4, subjectRanked: 10 },
  ] as never,
  termAverage: 73,
  termGrade: "A",
  position: 2,
  classSize: 10,
  sessionAverage: 71,
  sessionTermsCounted: 2,
  sessionTermsTotal: 3,
  att: { PRESENT: 46, ABSENT: 2, LATE: 1, EXCUSED: 0 },
  remarks: {
    classTeacher: null as { text: string; byName: string | null } | null,
    head: null as { text: string; byName: string | null; label: string } | null,
  },
  guardianNames: [] as string[],
  gender: "Female" as string | null,
  bands: GRADE_SCALES.WAEC.bands,
  cumulativeScore: 0,
  termBegins: new Date("2026-09-14T00:00:00Z"),
  termEnds: new Date("2026-12-12T00:00:00Z"),
  nextTermBegins: new Date("2027-01-06T00:00:00Z"),
  daysOpened: 49,
  traitRatings: [
    { traitKey: "obedience", score: 4 },
    { traitKey: "punctuality", score: 5 },
  ],
  totalTermScore: 146,
  annualTermNames: ["First Term", "Second Term", "Third Term"],
  annualBySubject: { s1: [81, 77, null], s2: [65, null, null] } as Record<string, Array<number | null>>,
  annualPosition: { s1: { position: 3, of: 30 } } as Record<string, { position: number; of: number }>,
  promotionLine: null as string | null,
};

// reason: renderPdf is private and needs none of the injected services — it is a
// pure function of its argument, which is exactly why it can be tested this way.
function render(overrides: Partial<typeof BASE> = {}): Promise<Buffer> {
  const svc = new ReportCardService(
    null as never, null as never, null as never, null as never, null as never, null as never, null as never,
  );
  return (svc as unknown as { renderPdf(d: unknown, logo?: Buffer | null): Promise<Buffer> }).renderPdf(
    { ...BASE, ...overrides },
    null,
  );
}

describe("the printed report card", () => {
  it("prints the pupil, class and term", async () => {
    const t = textOf(await render());
    expect(t).toContain("Ada Obi");
    expect(t).toContain("JSS1");
    expect(t).toContain("First Term");
  });

  it("prints skills and behaviour EVEN WITH NO REMARKS", async () => {
    // The defect this suite exists for. Ratings and remarks are separate acts by
    // possibly different people; a missing remark must not swallow the ratings.
    const t = textOf(await render({ remarks: { classTeacher: null, head: null } }));
    expect(t).toContain("Skills and behaviour");
    expect(t).toContain("Obedience");
    expect(t).toContain("Punctuality");
    expect(t).toContain("Total term score: 146");
  });

  it("prints them with remarks too", async () => {
    const t = textOf(
      await render({
        remarks: {
          classTeacher: { text: "A steady term.", byName: "Mrs Rahman" },
          head: { text: "Well done.", byName: "Dr Bello", label: "Principal's comments" },
        },
      }),
    );
    expect(t).toContain("Skills and behaviour");
    expect(t).toContain("A steady term.");
  });

  it("spells the 1–5 scale out, so a bare number is never the whole message", async () => {
    const t = textOf(await render());
    expect(t).toMatch(/5 = Maintains an excellent degree/);
  });

  it("omits the whole block when nothing was rated", async () => {
    const t = textOf(await render({ traitRatings: [] }));
    expect(t).not.toContain("Skills and behaviour");
  });

  it("never prints a group heading with no ratings under it", async () => {
    const t = textOf(await render({ traitRatings: [{ traitKey: "obedience", score: 4 }] }));
    const personal = TRAIT_GROUPS[0].label;
    expect(t).toContain(personal);
    for (const g of TRAIT_GROUPS.slice(1)) expect(t).not.toContain(g.label);
  });
});

describe("the marks table", () => {
  it("splits continuous assessment from the exam, as the printed format does", async () => {
    const t = textOf(await render());
    expect(t).toContain("C.A.");
    expect(t).toContain("Exam");
    // C.A. is midterm + assignment + class note: 15 + 8 + 8.
    expect(t).toContain("31");
  });

  it("sets the pupil's mark beside what the class did", async () => {
    const s = [{ ...(BASE.subjects as never as Record<string, unknown>[])[0], classAverage: 49, classLowest: 12, classHighest: 90 }];
    const t = textOf(await render({ subjects: s as never }));
    expect(t).toContain("49");
    expect(t).toContain("12/90");
  });
});

describe("attendance", () => {
  it("prints the denominator before the counts", async () => {
    const t = textOf(await render());
    expect(t).toContain("Times school opened: 49");
    expect(t.indexOf("Times school opened")).toBeLessThan(t.indexOf("Present: 46"));
  });

  it("prints when the next term begins — the only date about the future", async () => {
    expect(textOf(await render())).toContain("Next term begins: 2027-01-06");
  });
});

describe("the year so far", () => {
  it("shows each term's total per subject and the average across them", async () => {
    const t = textOf(await render());
    expect(t).toContain("The year so far");
    expect(t).toContain("Second Term");
    expect(t).toContain("79"); // (81 + 77) / 2
  });

  it("averages only the terms that HAVE marks", async () => {
    // A term with no marks is an absent measurement. Counting it as zero would
    // print a failure the pupil never earned.
    const t = textOf(await render({ annualBySubject: { s1: [90, null, 80], s2: [65, null, null] } }));
    expect(t).toContain("85");
    expect(t).not.toContain("57"); // (90 + 0 + 80) / 3
  });

  it("stays off a card with only one term of marks", async () => {
    const t = textOf(await render({ annualBySubject: { s1: [81, null, null], s2: [65, null, null] } }));
    expect(t).not.toContain("The year so far");
  });
});

describe("the promotion line", () => {
  it("prints the decision somebody recorded", async () => {
    expect(textOf(await render({ promotionLine: "PROMOTED TO JSS2" }))).toContain("PROMOTED TO JSS2");
  });

  it("prints NOTHING when nobody has decided", async () => {
    // Golden Rule #8: the system does not award a year off the back of an
    // average. An absent line is honest; a computed one would not be.
    const t = textOf(await render({ promotionLine: null }));
    expect(t).not.toMatch(/PROMOTED|REPEAT|GRADUATED/);
  });
});

// =============================================================================
// REMARKS AND CONCLUSION — the signed half of the document
// =============================================================================
// Everything above the remarks is arithmetic the system performed. This is a
// judgement a PERSON made, and the difference is the whole point of the block:
// `classTeacherId` / `headId` had been stamped since the table was created and
// no reader had ever looked at them, so a comment about a child printed with
// nobody's name against it — the school appearing to speak collectively about
// something one teacher wrote.
const TEACHER = { text: "Applies critical thinking with a common-sense approach.", byName: "Mrs H. Rahman" };
const HEAD = { text: "Excellent academic performance, keep it up.", byName: "Dr A. Bello", label: "Principal's comments" };

describe("the comments", () => {
  it("names the class teacher who wrote theirs", async () => {
    const t = textOf(await render({ remarks: { classTeacher: TEACHER, head: null } }));
    expect(t).toContain("CLASS TEACHER'S COMMENTS");
    expect(t).toContain(TEACHER.text);
    expect(t).toContain("Mrs H. Rahman");
  });

  it("names the principal who wrote theirs, under their own label", async () => {
    const t = textOf(await render({ remarks: { classTeacher: null, head: HEAD } }));
    expect(t).toContain("PRINCIPAL'S COMMENTS");
    expect(t).toContain(HEAD.text);
    expect(t).toContain("Dr A. Bello");
  });

  it("falls back to the role, never to an anonymous comment", async () => {
    // A remark written before authors were recorded still has to print as
    // somebody's, not as the building's.
    const t = textOf(await render({ remarks: { classTeacher: { text: "Steady.", byName: null }, head: null } }));
    expect(t).toContain("Class teacher");
  });

  it("labels a school administrator's remark as the head teacher's, not the principal's", async () => {
    // The head remark is staff-wide. Printing "Principal's comments" over a
    // school administrator's words is a small lie on a document families keep.
    const t = textOf(
      await render({
        remarks: { classTeacher: null, head: { text: "Noted.", byName: "Mr Okoro", label: "Head teacher's comments" } },
      }),
    );
    expect(t).toContain("HEAD TEACHER'S COMMENTS");
    expect(t).not.toContain("PRINCIPAL'S COMMENTS");
  });

  it("puts the promotion decision beside the principal's words", async () => {
    // One statement, not two. Separated, a card can be read as praising a child
    // it is holding back.
    const t = textOf(await render({ remarks: { classTeacher: null, head: HEAD }, promotionLine: "PROMOTED TO SS3" }));
    const stamp = t.indexOf("PROMOTED TO SS3");
    expect(stamp).toBeGreaterThan(t.indexOf("PRINCIPAL'S COMMENTS"));
    expect(stamp).toBeLessThan(t.indexOf("Signature, school stamp and date"));
  });

  it("still prints a decision that has no comment beside it", async () => {
    const t = textOf(await render({ remarks: { classTeacher: null, head: null }, promotionLine: "GRADUATED" }));
    expect(t).toContain("GRADUATED");
  });

  it("carries a place to sign and stamp", async () => {
    expect(textOf(await render({ remarks: { classTeacher: TEACHER, head: HEAD } }))).toContain(
      "Signature, school stamp and date",
    );
  });

  it("names the parents the card is going to", async () => {
    const t = textOf(await render({ remarks: { classTeacher: TEACHER, head: null }, guardianNames: ["Mr Olawale", "Mrs Olawale"] }));
    expect(t).toContain("Mr Olawale, Mrs Olawale");
  });
});

describe("the grade key", () => {
  it("states every band with its range and its word", async () => {
    // Without it "B3" is a code. A card a family cannot read has not reported
    // anything.
    const t = textOf(await render());
    expect(t).toContain("A1 75–100 excellent");
    expect(t).toContain("F9 0–39 fail");
  });

  it("closes each band at the floor of the one above, so no mark falls between", async () => {
    const t = textOf(await render());
    expect(t).toContain("B2 70–74");
    expect(t).toContain("B3 65–69");
  });

  it("prints the letter alone when a school's scale names no bands", async () => {
    // Describing a child's work in a word the school never chose is worse than
    // printing the letter on its own.
    const t = textOf(await render({ bands: [{ min: 50, grade: "PASS" }, { min: 0, grade: "FAIL" }] }));
    expect(t).toContain("PASS 50–100");
    expect(t).not.toMatch(/PASS 50–100 [a-z]/);
  });
});

describe("the word beside each mark", () => {
  it("appears in the term table", async () => {
    const t = textOf(await render());
    expect(t).toContain("Excellent"); // 81 on the WAEC scale
    expect(t).toContain("Good"); // 65
  });

  it("appears against the annual average too, with its grade", async () => {
    const t = textOf(await render());
    expect(t).toContain("Annual avg");
    expect(t).toContain("Grade");
  });
});

describe("the cumulative score", () => {
  it("adds every term's marks together", async () => {
    // 81 + 77 + 65 = 223 across the two subjects' recorded terms.
    const t = textOf(await render({ cumulativeScore: 223 }));
    expect(t).toContain("Cumulative score: 223");
  });

  it("stays off the card before there is a year to total", async () => {
    const t = textOf(await render({ cumulativeScore: 0 }));
    expect(t).not.toContain("Cumulative score");
  });
});

describe("personal data", () => {
  it("carries sex alongside the admission number", async () => {
    expect(textOf(await render())).toContain("Sex: Female");
  });

  it("omits it rather than guessing when the profile does not say", async () => {
    const t = textOf(await render({ gender: null }));
    expect(t).not.toContain("Sex:");
  });
});

describe("column headings", () => {
  it("never silently clips one", async () => {
    // The annual block's widths are derived from how many terms there are, so a
    // school on four quarters gets narrower columns than one on three terms. A
    // heading that no longer fits must be shortened VISIBLY — "Annual av" with
    // no ellipsis reads as the name of the column, and nobody would report it.
    const t = textOf(await render());
    for (const head of ["Subject", "Annual avg", "Grade", "Pos", "Remark"]) {
      expect(t).toContain(head);
    }
  });

  it("marks a heading it had to shorten", async () => {
    const t = textOf(
      await render({
        annualTermNames: ["First Quarter", "Second Quarter", "Third Quarter", "Fourth Quarter"],
        annualBySubject: { s1: [81, 77, 70, 66], s2: [65, 60, null, null] },
      }),
    );
    expect(t).toMatch(/…/);
  });
});

describe("what each column is out of", () => {
  it("states the maxima in the table, not only in a note at the foot", async () => {
    // A parent reading "37" under Exam should not have to find a sentence three
    // inches below to learn it was out of 60.
    const t = textOf(await render());
    expect(t).toContain("Maximum mark");
    expect(t).toContain("40"); // C.A. = midterm 20 + assignment 10 + note 10
    expect(t).toContain("60"); // exam
  });
});

describe("annual position", () => {
  it("sets the pupil's place in the subject across the whole year", async () => {
    expect(textOf(await render())).toContain("3/30");
  });

  it("prints a dash rather than a guess where the year cannot be ranked", async () => {
    const t = textOf(await render({ annualPosition: {} }));
    expect(t).not.toContain("3/30");
  });
});
