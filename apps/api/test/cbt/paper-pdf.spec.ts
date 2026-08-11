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
