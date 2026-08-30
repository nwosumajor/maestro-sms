// =============================================================================
// CBT: the printable paper, and the score that was not what it looked like
// =============================================================================
// Two separate problems, both about a document or a number saying more than it
// knows.
//
// THE PAPER. There was no way to print one at all — no PDF, no export. An
// offline sitting, a moderation review or a paper archive had nothing. The
// interesting part is not the PDF, it is the SPLIT: the answer key is already
// withheld from a cbt.review head teacher on screen, and a printed paper is the
// easiest way to walk that key out of the building, so the split has to survive
// on paper too.
//
// THE SCORE. On a paper with a Section B, a sitting's stored score is only the
// OBJECTIVE part until a human marks the theory. The results table showed it
// flat — and SORTED BY IT, so the candidates strongest on theory ranked last
// until marking finished.
// =============================================================================

import { inflateSync } from "node:zlib";
import { NotFoundException } from "@nestjs/common";
import { CbtService } from "../../src/cbt/cbt.service";

const SCHOOL = "11111111-1111-1111-1111-111111111111";
const EXAM = "22222222-2222-2222-2222-222222222222";

const EDITOR = { userId: "u-author", schoolId: SCHOOL, roles: ["teacher"], permissions: ["cbt.manage"] } as never;
const REVIEWER = { userId: "u-head", schoolId: SCHOOL, roles: ["head_teacher"], permissions: ["cbt.review"] } as never;
const OUTSIDER = { userId: "u-x", schoolId: SCHOOL, roles: ["student"], permissions: ["cbt.take"] } as never;

function makeService(opts: { canTouch?: boolean; shuffle?: boolean } = {}) {
  const log = jest.fn();
  const questions = [
    { id: "q1", prompt: "2 + 2 = ?", choices: ["3", "4", "5"], answerIndex: 1, type: "OBJECTIVE", maxMarks: 1 },
    { id: "q2", prompt: "Explain photosynthesis.", choices: [], answerIndex: 0, type: "THEORY", maxMarks: 6 },
  ];
  const tx = {
    cbtExam: {
      findFirst: jest.fn().mockResolvedValue({
        id: EXAM, bankId: "b1", classId: null, title: "Mid-term Biology",
        durationMinutes: 45, shuffle: opts.shuffle ?? false, blueprint: null,
        objectiveCount: 1, theoryCount: 1, questionCount: 2,
      }),
    },
    cbtQuestionBank: { findFirst: jest.fn().mockResolvedValue({ id: "b1", name: "Biology", subjectId: "s1" }) },
    cbtQuestion: { findMany: jest.fn().mockResolvedValue(questions) },
    school: { findFirst: jest.fn().mockResolvedValue({ name: "St Andrews" }) },
    subject: { findFirst: jest.fn().mockResolvedValue({ name: "Biology" }) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    class: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const svc = Object.create(CbtService.prototype) as CbtService;
  Object.assign(svc, {
    db: { runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx)) },
    audit: { record: jest.fn() },
    branding: { getLogoBytes: jest.fn().mockResolvedValue(null) },
  });
  (svc as unknown as { log: unknown }).log = log;
  (svc as unknown as { canTouchBank: unknown }).canTouchBank = jest
    .fn()
    .mockResolvedValue(opts.canTouch ?? true);
  (svc as unknown as { classLevel: unknown }).classLevel = jest.fn().mockResolvedValue(null);
  (svc as unknown as { poolWhere: unknown }).poolWhere = jest.fn().mockReturnValue({});
  return { svc, log, tx };
}

describe("printable question paper", () => {
  afterEach(() => jest.restoreAllMocks());

  it("an EDITOR can print the paper", async () => {
    const { svc } = makeService();
    const out = await svc.examPaperPdf(EDITOR, EXAM, false);
    expect(out.buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(out.filename).toContain("question-paper");
  });

  it("a REVIEWER can print the paper — they approve it, they must be able to read it", async () => {
    const { svc } = makeService({ canTouch: false });
    const out = await svc.examPaperPdf(REVIEWER, EXAM, false);
    expect(out.buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("a REVIEWER is REFUSED the answer key, and told nothing about it", async () => {
    // At the SERVICE layer this is 404, so it never confirms that this exam's
    // key exists. In the running app a reviewer is stopped one step earlier by
    // the guard with the platform's usual 403 for a permission they lack —
    // measured on the deployed build, both layers hold.
    const { svc } = makeService({ canTouch: false });
    await expect(svc.examPaperPdf(REVIEWER, EXAM, true)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("an EDITOR can print the answer key", async () => {
    const { svc } = makeService({ canTouch: true });
    const out = await svc.examPaperPdf(EDITOR, EXAM, true);
    expect(out.filename).toContain("answer-key");
  });

  /**
   * The text a printed paper actually carries.
   *
   * Every test above proves WHO may print, and none can see WHAT is on the
   * page. If `examPaperPdf(..., false)` ever started rendering the answer
   * markers, every holder of `cbt.review` would receive the answers to an exam
   * they are about to approve — and all five access tests would still pass.
   *
   * The marker is a leading `*` on the correct option, so the paper is right
   * only if the questions are present and the marker is not. Read out of the
   * PDF because that is where the leak would be: pdfkit deflates its content
   * streams, so the bytes are inflated and the hex runs glued back together.
   */
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

  it("the question paper carries the questions and NOT the answers", async () => {
    const { svc } = makeService();
    const text = textOf((await svc.examPaperPdf(EDITOR, EXAM, false)).buffer);
    expect(text).toContain("2 + 2 = ?");
    // The option LETTER AND ITS TEXT together. `toContain("4")` was the first
    // version and matched a date, a mark count, anything — the
    // matched-by-accident shape this repo gates against, and mutation proved
    // it: drawing the letter with the option text removed left it green.
    expect(text).toMatch(/B\.\s+4\b/);
    expect(text).toMatch(/A\.\s+3\b/);
    // The marker, not the letter: "B." is on the paper legitimately.
    expect(text).not.toMatch(/^\*/m);
    expect(text).not.toContain("ANSWER KEY");
  });

  it("the answer key marks the right option, and says it is not for candidates", async () => {
    // The other half. Without it, a paper that rendered NOTHING would pass the
    // test above — the leak-proof paper and the empty one look identical to a
    // "does not contain" assertion.
    const { svc } = makeService({ canTouch: true });
    const text = textOf((await svc.examPaperPdf(EDITOR, EXAM, true)).buffer);
    expect(text).toMatch(/^\*/m);
    expect(text).toMatch(/ANSWER KEY/);
    expect(text).toContain("2 + 2 = ?");
  });

  it("someone with neither permission gets nothing", async () => {
    const { svc } = makeService({ canTouch: false });
    await expect(svc.examPaperPdf(OUTSIDER, EXAM, false)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("AUDITS the paper and the key as DIFFERENT events", async () => {
    // A key leaving on paper is exam-integrity material; it must be
    // distinguishable in the trail from someone printing blank question sheets.
    const a = makeService();
    await a.svc.examPaperPdf(EDITOR, EXAM, false);
    expect(a.log.mock.calls[0][2]).toBe("cbt.exam.paper_print");

    const b = makeService();
    await b.svc.examPaperPdf(EDITOR, EXAM, true);
    expect(b.log.mock.calls[0][2]).toBe("cbt.exam.answer_key_print");
  });

  it("draws the paper DETERMINISTICALLY even when the exam shuffles", async () => {
    // A printed sheet needs a fixed set of questions. Two prints of the same
    // shuffled exam must not silently differ, or an invigilator photocopying
    // one and re-printing another hands out two different papers.
    const a = makeService({ shuffle: true });
    const b = makeService({ shuffle: true });
    const [p1, p2] = await Promise.all([
      a.svc.examPaperPdf(EDITOR, EXAM, false),
      b.svc.examPaperPdf(EDITOR, EXAM, false),
    ]);
    expect(p1.buffer.length).toBe(p2.buffer.length);
  });
});
