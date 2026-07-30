// =============================================================================
// CbtService — theory questions + human marking
// =============================================================================
// Theory reuses the objective banks/level/topic machinery; what's distinct is that
// a HUMAN awards the marks (Golden Rule #8 — nothing here is auto-scored). The
// behaviours that make it safe and usable:
//   AUTHORING — a theory question needs a mark ceiling, not choices/answerIndex;
//     the mark guide is marker-only.
//   SITTING   — an answer is ONE upserted row, and a re-save never touches a mark.
//   MARKING   — vertical (one question, every candidate), ANONYMOUS until the
//     question is fully marked, marks bounded by maxMarks, gated to the bank's
//     own teacher (404-not-403), audited.
//   SCORING   — only objective auto-marks; `total` is the whole paper's ceiling,
//     and the exam reads PROVISIONAL while any answer is unmarked.

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { CbtService } from "../../src/cbt/cbt.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: {
  bank?: Record<string, unknown> | null;
  exam?: Record<string, unknown> | null;
  question?: Record<string, unknown> | null;
  answers?: Record<string, unknown>[];
  answer?: Record<string, unknown> | null;
  taught?: { subjectId: string }[];
  sittings?: Record<string, unknown>[];
  signals?: Record<string, unknown>[];
  alreadyAlerted?: boolean;
  sitting?: Record<string, unknown> | null;
} = {}) {
  const createMany = jest.fn().mockResolvedValue({ count: 1 });
  const upsert = jest.fn().mockResolvedValue({ id: "ta1" });
  const update = jest.fn().mockResolvedValue({ id: "ta1" });
  const tx = {
    cbtQuestionBank: { findFirst: jest.fn().mockResolvedValue(over.bank ?? null) },
    cbtExam: { findFirst: jest.fn().mockResolvedValue(over.exam ?? null), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    cbtQuestion: {
      findFirst: jest.fn().mockResolvedValue(over.question ?? null),
      findMany: jest.fn().mockResolvedValue(over.question ? [over.question] : []),
      count: jest.fn().mockResolvedValue(5),
      createMany,
      groupBy: jest.fn().mockResolvedValue([]),
    },
    cbtTheoryAnswer: {
      findFirst: jest.fn().mockResolvedValue(over.answer ?? null),
      findMany: jest.fn().mockResolvedValue(over.answers ?? []),
      upsert,
      update,
    },
    cbtSitting: {
      findFirst: jest.fn().mockResolvedValue(over.sitting ?? null),
      findMany: jest.fn().mockResolvedValue(over.sittings ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    term: { findFirst: jest.fn().mockResolvedValue({ id: "term1", sessionId: "sess1" }) },
    integritySignal: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue(over.signals ?? []),
    },
    auditLog: { findFirst: jest.fn().mockResolvedValue(over.alreadyAlerted ? { id: "a1" } : null), findMany: jest.fn().mockResolvedValue([]) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue(over.taught ?? []), findFirst: jest.fn().mockResolvedValue(null) },
    class: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    user: {
      findMany: jest.fn().mockResolvedValue([{ id: "s1", name: "Ada" }, { id: "s2", name: "Bola" }]),
      findFirst: jest.fn().mockResolvedValue({ id: "s1", name: "Ada" }),
    },
  } as unknown as TenantTx;
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const workflow = { createRequest: jest.fn(), submit: jest.fn() };
  const hooks = { onFinalized: () => undefined };
  // CBT pushes scores into the gradebook; the push itself is tested there.
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const termResults = { applyExamComponent: jest.fn().mockResolvedValue({}) };
  const service = new CbtService(db as never, audit as never, workflow as never, termResults as never, notifications as never, hooks as never);
  return { service, tx, audit, createMany, upsert, update, termResults, notifications };
}

const teacher = (): Principal => ({ schoolId: "A", userId: "t1", roles: ["teacher"], permissions: ["cbt.manage"] });
const student = (): Principal => ({ schoolId: "A", userId: "s1", roles: ["student"], permissions: ["cbt.take"] });
const EXAM_FOR_INTEGRITY = { id: "e1", title: "Physics SS2A", classId: "c1", bankId: "b1" };
const admin = (): Principal => ({ schoolId: "A", userId: "adm", roles: ["school_admin"], permissions: ["cbt.manage"] });

const BANK = { id: "b1", createdById: "t1", subjectId: "sub-phy" };
const EXAM = { id: "e1", bankId: "b1" };
const THEORY_Q = { id: "q1", prompt: "State Newton's laws", markGuide: "1 mark per law", maxMarks: 5, type: "THEORY", bankId: "b1" };

describe("CBT theory questions", () => {
  describe("authoring", () => {
    it("stores a theory question with its mark ceiling and guide", async () => {
      const { service, createMany } = makeService({ bank: BANK, taught: [{ subjectId: "sub-phy" }] });
      await service.addQuestions(teacher(), "b1", [
        { prompt: "Explain refraction", choices: [], answerIndex: 0, type: "THEORY", maxMarks: 6, markGuide: " 2 per point " },
      ]);
      expect(createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ type: "THEORY", maxMarks: 6, markGuide: "2 per point" })],
        }),
      );
    });

    it("forces an OBJECTIVE question to be worth exactly 1 mark and carry no guide", async () => {
      const { service, createMany } = makeService({ bank: BANK, taught: [{ subjectId: "sub-phy" }] });
      await service.addQuestions(teacher(), "b1", [
        { prompt: "2+2?", choices: ["3", "4"], answerIndex: 1, maxMarks: 9, markGuide: "ignored" },
      ]);
      expect(createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: [expect.objectContaining({ maxMarks: 1, markGuide: null })] }),
      );
    });

    it("rejects a theory question with an out-of-range mark ceiling", async () => {
      const { service } = makeService({ bank: BANK, taught: [{ subjectId: "sub-phy" }] });
      await expect(
        service.addQuestions(teacher(), "b1", [{ prompt: "x", choices: [], answerIndex: 0, type: "THEORY", maxMarks: 0 }]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("still requires 2+ choices for an OBJECTIVE question", async () => {
      const { service } = makeService({ bank: BANK, taught: [{ subjectId: "sub-phy" }] });
      await expect(
        service.addQuestions(teacher(), "b1", [{ prompt: "x", choices: ["only"], answerIndex: 0 }]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("marking queue (vertical + anonymous)", () => {
    const twoUnmarked = [
      { id: "ta1", studentId: "s1", text: "answer one", marksAwarded: null, comment: null, markedAt: null },
      { id: "ta2", studentId: "s2", text: "answer two", marksAwarded: null, comment: null, markedAt: null },
    ];

    it("is ANONYMOUS while any answer is unmarked", async () => {
      const { service } = makeService({ bank: BANK, exam: EXAM, question: THEORY_Q, answers: twoUnmarked, taught: [{ subjectId: "sub-phy" }] });
      const q = await service.markingQueue(teacher(), "e1", "q1");
      expect(q.anonymous).toBe(true);
      expect(q.answers.map((a) => a.candidateLabel)).toEqual(["Candidate 1", "Candidate 2"]);
      expect(q.answers.every((a) => a.studentName === null)).toBe(true);
      // The marker DOES get the mark scheme and the ceiling.
      expect(q.markGuide).toBe("1 mark per law");
      expect(q.maxMarks).toBe(5);
      expect(q).toMatchObject({ marked: 0, total: 2 });
    });

    it("REVEALS names once every answer for the question is marked", async () => {
      const { service } = makeService({
        bank: BANK, exam: EXAM, question: THEORY_Q, taught: [{ subjectId: "sub-phy" }],
        answers: [
          { id: "ta1", studentId: "s1", text: "a", marksAwarded: 4, comment: null, markedAt: new Date() },
          { id: "ta2", studentId: "s2", text: "b", marksAwarded: 3, comment: null, markedAt: new Date() },
        ],
      });
      const q = await service.markingQueue(teacher(), "e1", "q1");
      expect(q.anonymous).toBe(false);
      expect(q.answers.map((a) => a.studentName)).toEqual(["Ada", "Bola"]);
      expect(q).toMatchObject({ marked: 2, total: 2 });
    });

    it("a plain teacher CANNOT force an early reveal; a school-wide admin can (audited)", async () => {
      const t = makeService({ bank: BANK, exam: EXAM, question: THEORY_Q, answers: twoUnmarked, taught: [{ subjectId: "sub-phy" }] });
      const asTeacher = await t.service.markingQueue(teacher(), "e1", "q1", { reveal: true });
      expect(asTeacher.anonymous).toBe(true); // ignored for a non-school-wide marker

      const a = makeService({ bank: BANK, exam: EXAM, question: THEORY_Q, answers: twoUnmarked });
      const asAdmin = await a.service.markingQueue(admin(), "e1", "q1", { reveal: true });
      expect(asAdmin.anonymous).toBe(false);
      expect(a.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "cbt.marking.reveal" }), expect.anything());
    });

    it("404s for a teacher outside the bank's subject (no existence disclosure)", async () => {
      const { service } = makeService({
        bank: { id: "b1", createdById: "someone-else", subjectId: "sub-chem" },
        exam: EXAM, question: THEORY_Q, taught: [{ subjectId: "sub-phy" }],
      });
      await expect(service.markingQueue(teacher(), "e1", "q1")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("refuses to hand-mark an OBJECTIVE question", async () => {
      const { service } = makeService({
        bank: BANK, exam: EXAM, taught: [{ subjectId: "sub-phy" }],
        question: { ...THEORY_Q, type: "OBJECTIVE" },
      });
      await expect(service.markingQueue(teacher(), "e1", "q1")).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("awarding a mark", () => {
    it("records the mark, marker and comment", async () => {
      const { service, update, audit } = makeService({
        bank: BANK, exam: EXAM, question: THEORY_Q, taught: [{ subjectId: "sub-phy" }],
        answer: { id: "ta1", examId: "e1", questionId: "q1" },
      });
      await service.markAnswer(teacher(), "ta1", 4, "  good  ");
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ta1" },
          data: expect.objectContaining({ marksAwarded: 4, comment: "good", markedById: "t1" }),
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "cbt.marking.mark" }), expect.anything());
    });

    it("refuses marks above the question's ceiling or below zero", async () => {
      const mk = () =>
        makeService({
          bank: BANK, exam: EXAM, question: THEORY_Q, taught: [{ subjectId: "sub-phy" }],
          answer: { id: "ta1", examId: "e1", questionId: "q1" },
        });
      await expect(mk().service.markAnswer(teacher(), "ta1", 6, null)).rejects.toBeInstanceOf(BadRequestException);
      await expect(mk().service.markAnswer(teacher(), "ta1", -1, null)).rejects.toBeInstanceOf(BadRequestException);
      // The boundaries themselves are fine.
      await expect(mk().service.markAnswer(teacher(), "ta1", 0, null)).resolves.toEqual({ ok: true });
      await expect(mk().service.markAnswer(teacher(), "ta1", 5, null)).resolves.toEqual({ ok: true });
    });

    it("refuses a fractional mark", async () => {
      const { service } = makeService({
        bank: BANK, exam: EXAM, question: THEORY_Q, taught: [{ subjectId: "sub-phy" }],
        answer: { id: "ta1", examId: "e1", questionId: "q1" },
      });
      await expect(service.markAnswer(teacher(), "ta1", 2.5, null)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("progress / provisional results", () => {
    it("is PROVISIONAL while any answer is unmarked, and settles once all are", async () => {
      const partly = makeService({
        bank: BANK, exam: EXAM, question: { id: "q1", prompt: "State Newton's laws", maxMarks: 5 }, taught: [{ subjectId: "sub-phy" }],
        answers: [
          { questionId: "q1", marksAwarded: 4 },
          { questionId: "q1", marksAwarded: null },
        ],
      });
      await expect(partly.service.markingProgress(teacher(), "e1")).resolves.toMatchObject({
        provisional: true,
        questions: [expect.objectContaining({ marked: 1, total: 2, maxMarks: 5 })],
      });

      const done = makeService({
        bank: BANK, exam: EXAM, question: { id: "q1", prompt: "q", maxMarks: 5 }, taught: [{ subjectId: "sub-phy" }],
        answers: [{ questionId: "q1", marksAwarded: 4 }, { questionId: "q1", marksAwarded: 5 }],
      });
      await expect(done.service.markingProgress(teacher(), "e1")).resolves.toMatchObject({ provisional: false });
    });

    it("an exam with no theory answers is not provisional", async () => {
      const { service } = makeService({ bank: BANK, exam: EXAM, answers: [], taught: [{ subjectId: "sub-phy" }] });
      await expect(service.markingProgress(teacher(), "e1")).resolves.toEqual({
        examId: "e1", provisional: false, questions: [],
      });
    });
  });

  describe("recording the combined score to the gradesheet", () => {
    const EXAM_FULL = { id: "e1", bankId: "b1", classId: "c1", termId: "term1" };

    it("records objective + theory, scaled to the exam component", async () => {
      // Paper: 2 objective (1 each) + 1 theory (5) = ceiling 7.
      // Script: 2 objective correct + 4 theory marks = 6/7 -> 6/7 * 60 = 51.43
      const { service, termResults } = makeService({
        bank: BANK, exam: EXAM_FULL, taught: [{ subjectId: "sub-phy" }],
        sittings: [{ id: "sg1", studentId: "s1", score: 2, questionIds: ["o1", "o2", "t1"] }],
        answers: [{ sittingId: "sg1", questionId: "t1", marksAwarded: 4 }],
        question: { id: "t1", type: "THEORY", maxMarks: 5 },
      });
      const res = await service.recordExamGrades(teacher(), "e1");
      expect(res).toMatchObject({ recorded: 1, skipped: 0, examMax: 60 });
      expect(termResults.applyExamComponent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ classId: "c1", subjectId: "sub-phy", termId: "term1", studentId: "s1", exam: 51.43 }),
      );
    });

    it("REFUSES while any theory answer is unmarked (never files a provisional total)", async () => {
      const { service, termResults } = makeService({
        bank: BANK, exam: EXAM_FULL, taught: [{ subjectId: "sub-phy" }],
        sittings: [{ id: "sg1", studentId: "s1", score: 2, questionIds: ["o1", "t1"] }],
        answers: [{ sittingId: "sg1", questionId: "t1", marksAwarded: null }],
        question: { id: "t1", type: "THEORY", maxMarks: 5 },
      });
      await expect(service.recordExamGrades(teacher(), "e1")).rejects.toBeInstanceOf(ConflictException);
      expect(termResults.applyExamComponent).not.toHaveBeenCalled();
    });

    it("an OBJECTIVE-ONLY paper records just the objective score", async () => {
      // 2 objective, both correct -> 2/2 * 60 = 60. No theory rows at all.
      const { service, termResults } = makeService({
        bank: BANK, exam: EXAM_FULL, taught: [{ subjectId: "sub-phy" }],
        sittings: [{ id: "sg1", studentId: "s1", score: 2, questionIds: ["o1", "o2"] }],
        answers: [],
        question: { id: "o1", type: "OBJECTIVE", maxMarks: 1 },
      });
      const res = await service.recordExamGrades(teacher(), "e1");
      expect(res.recorded).toBe(1);
      expect(termResults.applyExamComponent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ exam: 60 }),
      );
    });

    it("refuses a paper with no class or no subject (nothing to write to)", async () => {
      const noClass = makeService({
        bank: BANK, exam: { id: "e1", bankId: "b1", classId: null, termId: "term1" }, taught: [{ subjectId: "sub-phy" }],
      });
      await expect(noClass.service.recordExamGrades(teacher(), "e1")).rejects.toBeInstanceOf(BadRequestException);

      const noSubject = makeService({
        bank: { id: "b1", createdById: "t1", subjectId: null },
        exam: EXAM_FULL, taught: [],
      });
      await expect(noSubject.service.recordExamGrades(teacher(), "e1")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses when nothing has been submitted yet", async () => {
      const { service } = makeService({ bank: BANK, exam: EXAM_FULL, taught: [{ subjectId: "sub-phy" }], sittings: [] });
      await expect(service.recordExamGrades(teacher(), "e1")).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("exam integrity (signals only — never a penalty)", () => {
    const LIVE = { id: "sg1", examId: "e1", status: "IN_PROGRESS" };
    const focus = (awayMs: number) => ({ type: "FOCUS_LOSS", evidence: { awayMs } });

    it("records a focus loss and returns the running totals", async () => {
      const { service, tx } = makeService({
        sitting: LIVE, exam: EXAM_FOR_INTEGRITY, bank: BANK,
        signals: [focus(5000), focus(4000)],
      });
      const res = await service.recordIntegrityEvents(student(), "sg1", [{ type: "FOCUS_LOSS", awayMs: 4000 }]);
      expect(res).toMatchObject({ recorded: 1, focusLosses: 2, awayMs: 9000 });
      expect(tx.integritySignal.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ sittingId: "sg1", type: "FOCUS_LOSS", source: "CLIENT" })],
        }),
      );
    });

    it("marks a LONG single absence as high severity, a brief one as low", async () => {
      const long = makeService({ sitting: LIVE, exam: EXAM_FOR_INTEGRITY, bank: BANK, signals: [] });
      await long.service.recordIntegrityEvents(student(), "sg1", [{ type: "FOCUS_LOSS", awayMs: 45_000 }]);
      expect(long.tx.integritySignal.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: [expect.objectContaining({ severity: "HIGH" })] }),
      );
      const brief = makeService({ sitting: LIVE, exam: EXAM_FOR_INTEGRITY, bank: BANK, signals: [] });
      await brief.service.recordIntegrityEvents(student(), "sg1", [{ type: "FOCUS_LOSS", awayMs: 2000 }]);
      expect(brief.tx.integritySignal.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: [expect.objectContaining({ severity: "LOW" })] }),
      );
    });

    it("client signals are never presented as certain (confidence < 1)", async () => {
      const { service, tx } = makeService({ sitting: LIVE, exam: EXAM_FOR_INTEGRITY, bank: BANK, signals: [] });
      await service.recordIntegrityEvents(student(), "sg1", [{ type: "FOCUS_LOSS", awayMs: 3000 }]);
      const data = (tx.integritySignal.createMany as jest.Mock).mock.calls[0][0].data[0];
      expect(data.confidence).toBeLessThan(1);
      expect(data.detector).toBe("cbt-exam-room");
    });

    it("NOTIFIES once the threshold is crossed, and NEVER touches the sitting", async () => {
      const { service, notifications, tx } = makeService({
        sitting: LIVE, exam: EXAM_FOR_INTEGRITY, bank: BANK,
        signals: [focus(5000), focus(5000), focus(5000)], // 3 losses -> threshold
      });
      const res = await service.recordIntegrityEvents(student(), "sg1", [{ type: "FOCUS_LOSS", awayMs: 5000 }]);
      expect(res.alerted).toBe(true);
      expect(notifications.enqueue).toHaveBeenCalled();
      // GOLDEN RULE #8: no penalty, no auto-submit, no status change.
      expect(tx.cbtSitting.updateMany).not.toHaveBeenCalled();
    });

    it("does NOT re-alert a sitting that already alerted", async () => {
      const { service, notifications } = makeService({
        sitting: LIVE, exam: EXAM_FOR_INTEGRITY, bank: BANK, alreadyAlerted: true,
        signals: [focus(9000), focus(9000), focus(9000), focus(9000)],
      });
      const res = await service.recordIntegrityEvents(student(), "sg1", [{ type: "FOCUS_LOSS", awayMs: 9000 }]);
      expect(res.alerted).toBe(false);
      expect(notifications.enqueue).not.toHaveBeenCalled();
    });

    it("stays silent below the threshold", async () => {
      const { service, notifications } = makeService({
        sitting: LIVE, exam: EXAM_FOR_INTEGRITY, bank: BANK, signals: [focus(2000)],
      });
      const res = await service.recordIntegrityEvents(student(), "sg1", [{ type: "FOCUS_LOSS", awayMs: 2000 }]);
      expect(res.alerted).toBe(false);
      expect(notifications.enqueue).not.toHaveBeenCalled();
    });

    it("records nothing on a CLOSED sitting", async () => {
      const { service, tx } = makeService({ sitting: { ...LIVE, status: "SUBMITTED" }, exam: EXAM_FOR_INTEGRITY, bank: BANK });
      const res = await service.recordIntegrityEvents(student(), "sg1", [{ type: "FOCUS_LOSS", awayMs: 5000 }]);
      expect(res.recorded).toBe(0);
      expect(tx.integritySignal.createMany).not.toHaveBeenCalled();
    });

    it("404s on someone else's sitting", async () => {
      const { service } = makeService({ sitting: null });
      await expect(
        service.recordIntegrityEvents(student(), "sg-other", [{ type: "FOCUS_LOSS", awayMs: 1000 }]),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("refuses an oversized batch (a bad client can't flood the table)", async () => {
      const { service } = makeService({ sitting: LIVE });
      const many = Array.from({ length: 40 }, () => ({ type: "FOCUS_LOSS", awayMs: 1000 }));
      await expect(service.recordIntegrityEvents(student(), "sg1", many)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
