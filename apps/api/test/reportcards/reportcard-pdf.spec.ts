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
import { GRADE_COMPONENTS, GRADE_SCALES, TRAIT_GROUPS } from "@sms/types";
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

/**
 * Wrapped text arrives as several positioned runs, so a sentence that spans a
 * line break is not a contiguous substring of `textOf`. Flatten before
 * asserting about a SENTENCE; assert on the raw lines when the subject is a
 * table CELL, where the newline boundary is the thing being pinned.
 */
const flat = (t: string) => t.replace(/\u00b7/g, " ").replace(/\s+/g, " ");

const BASE = {
  studentName: "Ada Obi",
  schoolName: "St Andrews",
  admissionNumber: "ADM-1",
  className: "JSS1",
  termName: "First Term",
  subjects: [
    { subjectId: "s1", subjectName: "Mathematics", exam: 50, midterm: 15, assignment: 8, classNote: 8, total: 81, grade: "A1", complete: true, position: 1, subjectRanked: 10 },
    { subjectId: "s2", subjectName: "English", exam: 40, midterm: 12, assignment: 7, classNote: 6, total: 65, grade: "B3", complete: true, position: 4, subjectRanked: 10 },
  ] as never,
  termAverage: 73,
  termGrade: "B2",
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
  // The school's own weighting, exactly as every real card carries it. A fixture
  // without it models a card the service cannot produce.
  components: GRADE_COMPONENTS as ReadonlyArray<{ key: string; label: string; max: number }>,
  sessionName: "2026/2027" as string | null,
  locale: "en-NG",
  timezone: "Africa/Lagos",
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
  // No attestation by default: most of these cases are about the marks table,
  // and a card with no head remark genuinely carries none. The attestation's own
  // describe block supplies one.
  attestation: null as {
    code: string; version: number; approvedByName: string; approvedByRole: string;
    approvedAt: Date; verifyUrl: string;
  } | null,
};

// reason: renderPdf is private and needs none of the injected services — it is a
// pure function of its argument, which is exactly why it can be tested this way.
function render(overrides: Partial<typeof BASE> = {}): Promise<Buffer> {
  const svc = new ReportCardService(
    null as never, null as never, null as never, null as never, null as never, null as never, null as never,
    null as never,
  );
  return (svc as unknown as { renderPdf(d: unknown, logo?: Buffer | null): Promise<Buffer> }).renderPdf(
    { ...BASE, ...overrides },
    null,
  );
}

describe("the printed report card", () => {
  it("calls the document what this product calls it", async () => {
    // The gridded layout was taken from a real school's Continuous Assessment
    // Report, and its letterhead wording came along with it — renaming every
    // other school's card to something they do not call it.
    const t = textOf(await render());
    expect(t).toContain("Report Card");
    expect(t).not.toContain("Continuous Assessment Report");
  });

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
    expect(t).toContain("SKILLS DEVELOPMENT AND BEHAVIOURAL ATTRIBUTES");
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
    expect(t).toContain("SKILLS DEVELOPMENT AND BEHAVIOURAL ATTRIBUTES");
    expect(t).toContain("A steady term.");
  });

  it("spells the 1–5 scale out, so a bare number is never the whole message", async () => {
    const t = textOf(await render());
    expect(t).toMatch(/5 = Maintains an excellent degree/);
  });

  it("omits the whole block when nothing was rated", async () => {
    const t = textOf(await render({ traitRatings: [] }));
    expect(t).not.toContain("SKILLS DEVELOPMENT AND BEHAVIOURAL ATTRIBUTES");
  });

  it("never prints a group heading with no ratings under it", async () => {
    const t = textOf(await render({ traitRatings: [{ traitKey: "obedience", score: 4 }] }));
    expect(t).toContain(TRAIT_GROUPS[0].label.toUpperCase());
    for (const g of TRAIT_GROUPS.slice(1)) expect(t).not.toContain(g.label.toUpperCase());
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

  it("does NOT print four zeros when no register has been taken", async () => {
    // A STATEMENT ABOUT THE CHILD versus a statement about the school.
    //
    // "Times school opened" and "Attendance rate" were both suppressed when
    // they would be zero — correctly, there is nothing to say — while
    // "Present: 0  Late: 0  Absent: 0  Excused: 0" printed unconditionally. So
    // the two figures that give the zeros their meaning vanished in precisely
    // the case where the zeros mislead, and a parent read "my child was never
    // present" off a term that had not started.
    //
    // Live before this: a real pupil, term 2026-09-07 to 2026-12-18, card
    // generated 2026-08-25 — four zeros and nothing else.
    const t = textOf(await render({ att: { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 }, daysOpened: 0 }));
    expect(flat(t)).toContain("No attendance has been recorded for this term.");
    expect(t).not.toMatch(/Present: 0/);
    // And it does not claim the school failed to open: `daysOpened` is also
    // zero before a term begins, and when no class could be resolved.
    expect(t).not.toContain("Times school opened");
  });

  it("says the register WAS taken when the pupil is simply in none of it", async () => {
    // A different fact from the one above, and one the school can act on.
    const t = textOf(await render({ att: { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 }, daysOpened: 5 }));
    expect(t).toContain("Times school opened: 5");
    expect(flat(t)).toContain("No attendance was recorded for this student");
    expect(flat(t)).toContain("the register was taken on 5 days");
    expect(t).not.toMatch(/Present: 0/);
  });

  it("still prints the counts and the rate the moment there is one record", async () => {
    // The fix must not hide real attendance. One present day out of one.
    const t = textOf(await render({ att: { PRESENT: 1, ABSENT: 0, LATE: 0, EXCUSED: 0 }, daysOpened: 5 }));
    expect(t).toContain("Present: 1");
    expect(t).toContain("Attendance rate: 100%");
    expect(t).not.toContain("No attendance");
  });

  it("counts LATE as attended, and EXCUSED as neither", async () => {
    // Unchanged by the fix, and worth pinning beside it: the rate is
    // (present + late) / everything recorded.
    const t = textOf(await render({ att: { PRESENT: 6, ABSENT: 2, LATE: 2, EXCUSED: 0 }, daysOpened: 10 }));
    expect(t).toContain("Attendance rate: 80%");
  });

  it("prints when the next term begins — the only date about the future", async () => {
    expect(textOf(await render())).toContain("Next term begins: 2027-01-06");
  });
});

describe("the annual summary", () => {
  it("shows each term's total per subject and the average across them", async () => {
    const t = textOf(await render());
    expect(t).toContain("ANNUAL SUMMARY");
    expect(t).toContain("Second Term");
    expect(t).toContain("79"); // (81 + 77) / 2
  });

  it("averages only the terms that HAVE marks", async () => {
    // A term with no marks is an absent measurement. Counting it as zero would
    // print a failure the pupil never earned.
    const t = textOf(await render({ annualBySubject: { s1: [90, null, 80], s2: [65, null, null] } }));
    // Pinned to the ROW, not to the document. This read `expect(t).not
    // .toContain("57")` over the whole PDF, so any incidental 57 anywhere —
    // a generated-at time, an id — failed it: it went red once under full-suite
    // parallelism and passed on a re-run, which is the worst kind of gate,
    // because the next person spends their time proving their change innocent.
    // The cells are newline-separated, so the row pins the average to the marks
    // it was computed from.
    // First Term is the card's own term, so the annual columns are Second and
    // Third: "—" then 80, and 85 is the average of the two terms that HAVE
    // marks (90 and 80), never of three.
    expect(t).toContain("\n—\n80\n85\n");
    expect(t).not.toContain("\n—\n80\n57\n"); // (90 + 0 + 80) / 3
  });

  it("stays off a card with only one term of marks", async () => {
    const t = textOf(await render({ annualBySubject: { s1: [81, null, null], s2: [65, null, null] } }));
    expect(t).not.toContain("ANNUAL SUMMARY");
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

describe("the attestation block", () => {
  const attested = {
    attestation: {
      code: "ABCD1234EFGH",
      version: 1,
      approvedByName: "Mrs Ngozi Adeyemi",
      approvedByRole: "Principal",
      approvedAt: new Date("2026-12-11T00:00:00Z"),
      verifyUrl: "https://sms.example/verify/card/st-andrews/ABCD1234EFGH",
    },
  };

  it("names who approved the card, in what role, and when", async () => {
    // The block it sits beside is a ruled line signed by hand after printing,
    // which leaves the VAULT copy — the one a guardian downloads — permanently
    // blank. This is the half that reaches them.
    const t = textOf(await render(attested as never));
    expect(t).toContain("Approved by Mrs Ngozi Adeyemi (Principal) on 11 December 2026.");
  });

  it("prints the code grouped for a person typing it off the page", async () => {
    const t = textOf(await render(attested as never));
    expect(t).toContain("ABCD-1234-EFGH");
  });

  it("prints the issue number, which a holder cannot otherwise know", async () => {
    // A card reissued after a correction leaves earlier printouts looking
    // identical and no longer current.
    const t = textOf(await render({ attestation: { ...attested.attestation, version: 3 } } as never));
    expect(t).toMatch(/Issue 3/);
  });

  it("tells the reader where to check it", async () => {
    const t = textOf(await render(attested as never));
    expect(t).toContain("sms.example/verify/card/st-andrews/ABCD1234EFGH");
  });

  it("says nothing at all when nobody has signed", async () => {
    // No head remark means no attestation, and a block claiming an approval that
    // did not happen is the exact failure this exists to prevent.
    const t = textOf(await render({ attestation: null }));
    expect(t).not.toContain("VERIFIED SCHOOL RECORD");
    expect(t).not.toMatch(/Approved by/);
  });
});

describe("a rating recorded under a trait the catalogue has since retired", () => {
  // The block walks TRAIT_GROUPS and picks up the ratings it recognises, so
  // removing a trait from the catalogue took every historical rating of it off
  // every past card — silently. `isTraitKey` refuses an unknown key on the way
  // in, so these are only ever rows the catalogue has moved on from.
  const withRetired = {
    traitRatings: [
      { traitKey: "punctuality", score: 5 },
      { traitKey: "somethingRetired", score: 3 },
    ],
  };

  it("still prints, under the key the catalogue no longer has a label for", async () => {
    const t = textOf(await render(withRetired as never));
    expect(t).toContain("OTHER RECORDED TRAITS");
    // A grid cell per trait and per score, like every other rated trait.
    expect(t).toContain("somethingRetired");
    // and the catalogued one is untouched
    expect(t).toContain("Punctuality");
  });

  it("adds no heading when every rating is one the catalogue knows", async () => {
    const t = textOf(await render({ traitRatings: [{ traitKey: "punctuality", score: 5 }] } as never));
    expect(t).toContain("Punctuality");
    expect(t).not.toContain("OTHER RECORDED TRAITS");
  });
});

describe("a grade the card's own key does not explain", () => {
  // A PUBLISHED grade is a snapshot — `reportedTermGrade` reports the letter it
  // was published with, so history does not move when a school changes its
  // scale. The key at the foot is TODAY's. Measured on a school that published
  // under simple letters and then set UK GCSE 9-1: subject grades A/B/C/D/E/F
  // printed under a key reading "9 90-100 | 8 80-89 | ... | 1 0-19" — a key
  // explaining not one letter on the page.
  // ONE term of marks, so the ANNUAL SUMMARY columns stay off the card. Their
  // Remark is derived from the annual AVERAGE, which is computed live and is
  // right to carry today's word — so leaving them on would put a legitimate
  // "Very good" on the page and make the anchor below untestable.
  const staleScale = {
    bands: GRADE_SCALES.SIMPLE_LETTER.bands,
    annualBySubject: { s1: [81, null, null], s2: [65, null, null] },
  };

  it("says so, naming the grades, rather than printing a key that fits none of them", async () => {
    // A1 and B3 are WAEC letters; the school's scale is now A-F.
    const t = textOf(await render(staleScale));
    expect(flat(t)).toMatch(/A1, B3 below were awarded on the grading scale in force when the mark was published/);
    expect(flat(t)).toContain("not in the key above");
  });

  it("stays off a card whose grades the key does explain", async () => {
    // The standing-disclaimer rule this file already applies elsewhere: a note
    // on every card is a note nobody reads.
    const t = textOf(await render());
    expect(flat(t)).not.toContain("not in the key above");
  });

  it("never puts a word from today's scale beside a letter from the old one", async () => {
    // The Remark column re-banded the TOTAL against today's bands while the
    // Grade column showed the frozen letter, so the two named different bands
    // on the same row. English's 65 re-bands to B "Very good" on A-F, and its
    // letter is B3, which that scale does not have — so the honest answer is no
    // word at all.
    //
    // "Very good" is the anchor precisely because nothing else on this card can
    // produce it: the term average (73) and the session average (71) both band
    // to A "Excellent", and the key prints its labels lower-cased. An earlier
    // draft asserted "Excellent" and went red on the annual average's
    // descriptor, which is computed live and is right to be there.
    const t = textOf(await render(staleScale));
    expect(t).not.toContain("Very good");
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
    // A labelled cell and its value, the way the printed format carries it.
    const t = textOf(await render());
    const cells = t.split("\n");
    expect(cells[cells.indexOf("SEX") + 1]).toBe("Female");
    expect(cells.indexOf("ADMISSION NO.")).toBeGreaterThan(-1);
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

describe("a component mark above the school's own maximum", () => {
  // The total is a sum of CLAMPED components; every reader printed the RAW ones
  // beside it. A school that lowers its exam weighting after marks are entered
  // gets a row that does not add up. Measured live on a school moving to
  // 40/20/30/10 with a 42 already recorded: the card printed
  // "C.A. 28 · Exam 42 · Total 68" under a header saying the exam is out of 40.
  //
  // Clamping is the right arithmetic — 42 out of 40 is not a mark. Printing the
  // unclamped figure beside a total that ignores it is what made the page
  // incoherent, and a parent adding up the row got a different answer.
  const LOW_EXAM = [
    { key: "exam", label: "Exam", max: 40 },
    { key: "midterm", label: "Midterm test", max: 20 },
    { key: "assignment", label: "Assignment", max: 30 },
    { key: "classNote", label: "Class note", max: 10 },
  ];
  const overMax = {
    components: LOW_EXAM,
    subjects: [
      {
        subjectId: "s1", subjectName: "English", exam: 42, midterm: 12, assignment: 7,
        classNote: 6, total: 65, grade: "B3", complete: true, position: 4, subjectRanked: 10,
      },
    ],
  };

  it("prints the mark AS IT COUNTS, so the row adds up to its own total", async () => {
    const t = textOf(await render(overMax as never));
    // READ THE CELL, not the document. `not.toMatch(/\b42\b/)` over the whole
    // page went red the moment the card grew a generated-at timestamp, because
    // 5:42 pm contains 42 — the same accident this repo has recorded three times.
    const cells = t.split("\n");
    const at = cells.indexOf("English");
    expect(at).toBeGreaterThan(-1);
    expect(cells[at + 1]).toBe("25"); // C.A. = 12 + 7 + 6
    expect(cells[at + 2]).toBe("40"); // the exam AS IT COUNTS, never the 42 stored
    expect(cells[at + 3]).toBe("65"); // and 25 + 40 is the total beside them
  });

  it("never prints a component above the maximum stated in its own header", async () => {
    const t = textOf(await render(overMax as never));
    // The header this card prints for the exam column.
    expect(t).toMatch(/Maximum mark[\s\S]{0,40}40/);
  });

  it("clamps a CONTINUOUS-ASSESSMENT component too, not just the exam", async () => {
    // Caught by mutation: the first assertion above only ever exercised the exam
    // column, because every C.A. component in that fixture was already within
    // its maximum. Reverting the C.A. sum to the raw marks kept the suite green.
    // classNote 14 against a maximum of 10 is what makes this row bite.
    const t = textOf(
      await render({
        components: LOW_EXAM,
        subjects: [
          {
            subjectId: "s1", subjectName: "English", exam: 30, midterm: 12, assignment: 7,
            classNote: 14, total: 59, grade: "C", complete: true, position: 4, subjectRanked: 10,
          },
        ],
      } as never),
    );
    // C.A. = 12 + 7 + 10 = 29, never 12 + 7 + 14 = 33.
    expect(t).toMatch(/\b29\b/);
    expect(t).not.toMatch(/\b33\b/);
  });

  it("prints a dash for a component nobody has marked, never a zero", async () => {
    // Caught by mutation: making effectiveComponents return 0 for null left the
    // whole suite green, and an unmarked exam would have printed "0".
    //
    // The distinction is the reason the helper preserves null. This card already
    // reasons about it one line away — a total with a component unmarked counts
    // it as ZERO, so the row carries an asterisk because a family cannot tell
    // "scored 24" from "only the class note is in". Printing a bare 0 in the
    // column makes that worse: it reads as a mark the child was given.
    const t = textOf(
      await render({
        components: LOW_EXAM,
        subjects: [
          {
            subjectId: "s1", subjectName: "English", exam: null, midterm: 12, assignment: 7,
            classNote: 6, total: 25, grade: "F", complete: false, position: 4, subjectRanked: 10,
          },
        ],
      } as never),
    );
    // Cell by cell: the extractor puts each table cell on its own line, so the
    // row is read positionally rather than with a line-spanning regex.
    const cells = t.split("\n");
    const at = cells.indexOf("English *");
    expect(at).toBeGreaterThan(-1);
    expect(cells[at + 1]).toBe("25"); // C.A. = 12 + 7 + 6
    // The exam column is a dash. A zero there is a mark; an unmarked exam is not.
    expect(cells[at + 2]).toBe("—");
  });

  it("leaves a mark within the maximum exactly as the teacher entered it", async () => {
    // Clamping must not become rounding: the ordinary case is untouched.
    const t = textOf(await render());
    expect(t).toMatch(/\b50\b/);
    expect(t).toMatch(/\b81\b/);
  });
});
