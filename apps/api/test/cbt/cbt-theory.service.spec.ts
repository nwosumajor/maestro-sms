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

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CbtService } from "../../src/cbt/cbt.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: {
  bank?: Record<string, unknown> | null;
  exam?: Record<string, unknown> | null;
  question?: Record<string, unknown> | null;
  answers?: Record<string, unknown>[];
  answer?: Record<string, unknown> | null;
  taught?: { subjectId: string }[];
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
    cbtSitting: { findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue(over.taught ?? []), findFirst: jest.fn().mockResolvedValue(null) },
    class: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "s1", name: "Ada" }, { id: "s2", name: "Bola" }]) },
  } as unknown as TenantTx;
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const workflow = { createRequest: jest.fn(), submit: jest.fn() };
  const hooks = { onFinalized: () => undefined };
  const service = new CbtService(db as never, audit as never, workflow as never, hooks as never);
  return { service, tx, audit, createMany, upsert, update };
}

const teacher = (): Principal => ({ schoolId: "A", userId: "t1", roles: ["teacher"], permissions: ["cbt.manage"] });
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
});
