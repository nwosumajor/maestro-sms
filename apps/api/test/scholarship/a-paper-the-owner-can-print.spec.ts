/**
 * A PHYSICAL scholarship exam could be authored and had NOWHERE to send the
 * questions.
 *
 * `announceExam` materialises a CBT exam only for ONLINE_CBT, so for a paper
 * sitting `examQuestions` was stored, readable in the operator console, and
 * used by NOTHING — measured live: a physical programme announced with
 * `cbtExams: 0`, and no print path anywhere in the module. The console did not
 * even show the composer for one, so the questions could not be written either.
 */
import { inflateSync } from "node:zlib";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ScholarshipAdminService } from "../../src/scholarship/scholarship-admin.service";

const P = { userId: "op", schoolId: "plat", roles: ["super_admin"], permissions: [] } as never;

/** pdfkit writes text as HEX strings. Decoding octal instead reported an empty
 *  document — a fact about the extractor, not about the PDF. */
function textOf(pdf: Buffer): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const st = pdf.indexOf("\nstream", i);
    if (st === -1) break;
    let from = st + 7;
    while (pdf[from] === 0x0d || pdf[from] === 0x0a) from += 1;
    const e = pdf.indexOf("endstream", from);
    if (e === -1) break;
    i = e + 9;
    let raw: string;
    try {
      raw = inflateSync(pdf.subarray(from, e)).toString("latin1");
    } catch {
      continue;
    }
    for (const chunk of raw.split(/\bTm\b/)) {
      const line = [...chunk.matchAll(/<([0-9A-Fa-f]+)>/g)]
        .map((m) => Buffer.from(m[1], "hex").toString("latin1"))
        .join("");
      if (line.trim()) out.push(line.trim());
    }
  }
  return out.join("\n");
}

const QUESTIONS = [
  { text: "Which is prime?", options: ["4", "6", "8", "9", "11"], answerIndex: 4, subject: "Mathematics" },
  { text: "Seven eights?", options: ["54", "56", "58", "62", "64"], answerIndex: 1, subject: "Mathematics" },
  { text: "Choose the verb.", options: ["quickly", "house", "ran", "blue", "tall"], answerIndex: 2, subject: "English" },
];

function svc(over: Record<string, unknown> = {}) {
  const audits: Array<{ action: string; meta: Record<string, unknown> }> = [];
  const db = {
    scholarshipProgram: {
      findFirst: async () =>
        over.program === null
          ? null
          : {
              title: "PROBE Prize",
              category: "SPECIAL",
              examQuestions: over.questions ?? QUESTIONS,
              examDurationMin: 45,
              examSchedule: over.schedule ?? null,
              examMode: "PHYSICAL",
            },
    },
  };
  const s = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
  Object.assign(s, {
    client: () => db,
    auditOwn: async (_p: unknown, action: string, _id: string, meta: Record<string, unknown>) => {
      audits.push({ action, meta });
    },
  });
  return { s, audits };
}

describe("the owner can print a scholarship paper", () => {
  it("prints the questions of the subject asked for", async () => {
    const { s } = svc();
    const { buffer } = await s.examPaperPdf(P, "prog", "Mathematics", false);
    const t = textOf(buffer);
    expect(t).toMatch(/Which is prime\?/);
    expect(t).toMatch(/Seven eights\?/);
  });

  // ONE SUBJECT PER CALL. The papers are DERIVED from the questions' subjects,
  // so printing "the programme" would staple two different exams together.
  it("does not leak another subject's paper into it", async () => {
    const { s } = svc();
    const t = textOf((await s.examPaperPdf(P, "prog", "Mathematics", false)).buffer);
    expect(t).not.toMatch(/Choose the verb/);
    const english = textOf((await s.examPaperPdf(P, "prog", "English", false)).buffer);
    expect(english).toMatch(/Choose the verb/);
    expect(english).not.toMatch(/Which is prime/);
  });

  // The paper and the key must differ in BOTH directions: a key that carries no
  // questions is as useless as a paper that carries the answers.
  it("keeps the key off the question paper", async () => {
    const { s } = svc();
    const paper = textOf((await s.examPaperPdf(P, "prog", "Mathematics", false)).buffer);
    expect(paper).toMatch(/E\.\s+11/);
    expect(paper).not.toMatch(/\*E\.\s+11/);
    expect(paper).not.toMatch(/NOT FOR CANDIDATES/);
  });

  it("marks the answer on the key, and says it is not for candidates", async () => {
    const { s } = svc();
    const key = textOf((await s.examPaperPdf(P, "prog", "Mathematics", true)).buffer);
    expect(key).toMatch(/Which is prime\?/);
    expect(key).toMatch(/\*E\.\s+11/);
    expect(key).toMatch(/NOT FOR CANDIDATES/);
  });

  // The heading is the PLATFORM's, not a school's — an invigilator reading a
  // competing school's name on a national paper is its own problem.
  it("heads the paper as the platform's, naming no school", async () => {
    const { s } = svc();
    const t = textOf((await s.examPaperPdf(P, "prog", "Mathematics", false)).buffer);
    expect(t).toMatch(/Scholarship exam/);
  });

  // Printing a key is exam-integrity material and must be distinguishable in
  // the trail from printing the paper.
  it("audits the key separately from the paper", async () => {
    const { s, audits } = svc();
    await s.examPaperPdf(P, "prog", "Mathematics", false);
    await s.examPaperPdf(P, "prog", "Mathematics", true);
    expect(audits.map((a) => a.action)).toEqual(["scholarship.paper.print", "scholarship.answer-key.print"]);
    expect(audits[1].meta).toMatchObject({ subject: "Mathematics", questions: 2 });
  });

  it("names the papers that DO exist rather than refusing blankly", async () => {
    const { s } = svc();
    await expect(s.examPaperPdf(P, "prog", "Chemistry", false)).rejects.toThrow(/Mathematics, English/);
  });

  it("takes the first paper when no subject is named", async () => {
    const { s } = svc();
    const { filename } = await s.examPaperPdf(P, "prog", null, false);
    expect(filename).toMatch(/mathematics/);
  });

  it("refuses a programme with no questions rather than printing a blank sheet", async () => {
    const { s } = svc({ questions: [] });
    await expect(s.examPaperPdf(P, "prog", null, false)).rejects.toThrow(BadRequestException);
  });

  it("404s a programme that does not exist", async () => {
    const { s } = svc({ program: null });
    await expect(s.examPaperPdf(P, "nope", null, false)).rejects.toThrow(NotFoundException);
  });

  // A per-subject schedule can set its own duration — a staggered exam has one
  // per paper, and printing the programme default on all of them would be wrong
  // on every sheet but the first.
  it("prints the subject's own duration when the schedule sets one", async () => {
    const { s } = svc({ schedule: { Mathematics: { durationMin: 90 } } });
    const t = textOf((await s.examPaperPdf(P, "prog", "Mathematics", false)).buffer);
    expect(t).toMatch(/90 minutes/);
    const english = textOf((await s.examPaperPdf(P, "prog", "English", false)).buffer);
    expect(english).toMatch(/45 minutes/);
  });
});
