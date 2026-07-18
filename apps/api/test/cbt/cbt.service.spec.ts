// =============================================================================
// CbtService — teacher subject/class scoping, the CBT_EXAM_PUBLISH and
// CBT_ANSWER_RELEASE maker-checkers, and the answer-key release gate on the
// student sitting view.
// =============================================================================

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { CbtService } from "../../src/cbt/cbt.service";
import type { FinalizedHandler } from "../../src/workflow/workflow-hooks.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: {
  bank?: Record<string, unknown> | null;
  banks?: Record<string, unknown>[];
  taught?: { subjectId: string; classId?: string }[];
  teachesLookup?: boolean;
  subject?: Record<string, unknown> | null;
  klass?: Record<string, unknown> | null;
  exam?: Record<string, unknown> | null;
  examUpdateCount?: number;
  questionCount?: number;
  sitting?: Record<string, unknown> | null;
  questions?: Record<string, unknown>[];
  workflowFails?: boolean;
}) {
  const examUpdateMany = jest.fn().mockResolvedValue({ count: over.examUpdateCount ?? 1 });
  const bankCreate = jest.fn(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "bank-new", createdAt: new Date(), ...data }),
  );
  const tx = {
    cbtQuestionBank: {
      findFirst: jest.fn().mockResolvedValue(over.bank ?? null),
      findMany: jest.fn().mockResolvedValue(over.banks ?? []),
      create: bankCreate,
    },
    cbtQuestion: {
      count: jest.fn().mockResolvedValue(over.questionCount ?? 5),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue(over.questions ?? []),
    },
    cbtExam: {
      findFirst: jest.fn().mockResolvedValue(over.exam ?? null),
      updateMany: examUpdateMany,
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: "exam-new", status: "DRAFT", answerRelease: "HIDDEN", answersReleasedAt: null, ...data }),
      ),
    },
    cbtSitting: {
      findFirst: jest.fn().mockResolvedValue(over.sitting ?? null),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    classSubjectTeacher: {
      findMany: jest.fn().mockResolvedValue((over.taught ?? []).map((t) => ({ subjectId: t.subjectId }))),
      findFirst: jest.fn().mockResolvedValue(over.teachesLookup ? { id: "cst1" } : null),
    },
    subject: {
      findFirst: jest.fn().mockResolvedValue(over.subject ?? null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    class: {
      findFirst: jest.fn().mockResolvedValue(over.klass ?? null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    enrollment: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    scholarshipApplication: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const workflow = over.workflowFails
    ? {
        createRequest: jest.fn().mockRejectedValue(new Error("workflow down")),
        submit: jest.fn(),
      }
    : {
        createRequest: jest.fn().mockResolvedValue({ id: "wf1" }),
        submit: jest.fn().mockResolvedValue(undefined),
      };
  let finalized: FinalizedHandler | undefined;
  const hooks = { onFinalized: (h: FinalizedHandler) => { finalized = h; } };
  const service = new CbtService(db as never, audit as never, workflow as never, hooks as never);
  return { service, tx, audit, workflow, examUpdateMany, bankCreate, finalized: finalized! };
}

const teacher = (userId = "t1"): Principal => ({ schoolId: "A", userId, roles: ["teacher"], permissions: [] });
const admin = (userId = "adm1"): Principal => ({ schoolId: "A", userId, roles: ["school_admin"], permissions: [] });

describe("CbtService — teacher subject scoping", () => {
  it("a teacher must pick a subject for a new bank", async () => {
    const { service } = makeService({});
    await expect(service.createBank(teacher(), { name: "Fractions" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a teacher cannot create a bank for a subject they don't teach (404, not 403)", async () => {
    const { service } = makeService({ teachesLookup: false, subject: { name: "Chemistry" } });
    await expect(
      service.createBank(teacher(), { name: "Organic", subjectId: "sub-chem" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a teacher creates a bank for a taught subject; the subject label is resolved and it's audited", async () => {
    const { service, audit } = makeService({ teachesLookup: true, subject: { name: "Mathematics" } });
    const bank = await service.createBank(teacher(), { name: "Fractions", subjectId: "sub-math" });
    expect(bank.subject).toBe("Mathematics");
    expect(bank.subjectId).toBe("sub-math");
    expect(audit.record).toHaveBeenCalled();
  });

  it("school-wide staff may create a bank with no subject", async () => {
    const { service } = makeService({});
    const bank = await service.createBank(admin(), { name: "General knowledge" });
    expect(bank.subjectId).toBeNull();
  });

  it("a teacher cannot add questions to a bank outside their subjects (404, not 403)", async () => {
    const { service } = makeService({
      bank: { id: "b1", createdById: "someone-else", subjectId: "sub-chem" },
      taught: [{ subjectId: "sub-math" }],
    });
    await expect(
      service.addQuestions(teacher(), "b1", [{ prompt: "Q", choices: ["a", "b"], answerIndex: 0 }]),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a teacher may add questions to a bank for a subject they teach", async () => {
    const { service, tx } = makeService({
      bank: { id: "b1", createdById: "someone-else", subjectId: "sub-math" },
      taught: [{ subjectId: "sub-math" }],
    });
    const res = await service.addQuestions(teacher(), "b1", [{ prompt: "Q", choices: ["a", "b"], answerIndex: 0 }]);
    expect(res.added).toBe(1);
    expect((tx as unknown as { cbtQuestion: { createMany: jest.Mock } }).cbtQuestion.createMany).toHaveBeenCalled();
  });

  it("a teacher's exam must name one of their classes", async () => {
    const { service } = makeService({ bank: { id: "b1", createdById: "t1", subjectId: "sub-math" } });
    await expect(
      service.createExam(teacher(), {
        bankId: "b1",
        title: "Test",
        questionCount: 5,
        durationMinutes: 30,
        startAt: new Date().toISOString(),
        endAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a teacher cannot aim an exam at a class where they don't teach the bank's subject (404)", async () => {
    const { service } = makeService({
      bank: { id: "b1", createdById: "t1", subjectId: "sub-math" },
      teachesLookup: false,
    });
    await expect(
      service.createExam(teacher(), {
        bankId: "b1",
        title: "Test",
        classId: "c-other",
        questionCount: 5,
        durationMinutes: 30,
        startAt: new Date().toISOString(),
        endAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("CbtService — exam publish maker-checker", () => {
  const draftExam = { id: "e1", title: "Mock", bankId: "b1", createdById: "t1", status: "DRAFT" };

  it("requestPublish claims the draft and raises a CBT_EXAM_PUBLISH request", async () => {
    const { service, workflow, examUpdateMany } = makeService({ exam: draftExam });
    const res = await service.requestPublish(teacher("t1"), "e1");
    expect(res).toEqual({ pendingApproval: true, requestId: "wf1" });
    expect(examUpdateMany).toHaveBeenCalledWith({
      where: { id: "e1", status: "DRAFT" },
      data: { status: "PENDING_APPROVAL" },
    });
    expect(workflow.createRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "CBT_EXAM_PUBLISH", payload: { examId: "e1" } }),
    );
    expect(workflow.submit).toHaveBeenCalledWith(expect.anything(), "wf1");
  });

  it("another teacher cannot request publish of an exam they didn't create (404)", async () => {
    const { service } = makeService({ exam: draftExam });
    await expect(service.requestPublish(teacher("t2"), "e1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a non-draft exam can't be re-submitted (idempotency guard)", async () => {
    const { service } = makeService({ exam: { ...draftExam, status: "PENDING_APPROVAL" }, examUpdateCount: 0 });
    await expect(service.requestPublish(teacher("t1"), "e1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("releases the claim (back to DRAFT) when raising the workflow request fails", async () => {
    const { service, examUpdateMany } = makeService({ exam: draftExam, workflowFails: true });
    await expect(service.requestPublish(teacher("t1"), "e1")).rejects.toThrow("workflow down");
    expect(examUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "e1", status: "PENDING_APPROVAL" },
      data: { status: "DRAFT" },
    });
  });

  it("the finalized reactor publishes on APPROVED and reverts to DRAFT on REJECTED", async () => {
    const { tx, examUpdateMany, finalized } = makeService({});
    await finalized(tx, {
      id: "wf1", schoolId: "A", type: "CBT_EXAM_PUBLISH", state: "APPROVED", payload: { examId: "e1" }, initiatorId: "t1",
    });
    expect(examUpdateMany).toHaveBeenCalledWith({
      where: { id: "e1", status: "PENDING_APPROVAL" },
      data: { status: "PUBLISHED" },
    });
    await finalized(tx, {
      id: "wf2", schoolId: "A", type: "CBT_EXAM_PUBLISH", state: "REJECTED", payload: { examId: "e1" }, initiatorId: "t1",
    });
    expect(examUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "e1", status: "PENDING_APPROVAL" },
      data: { status: "DRAFT" },
    });
  });

  it("direct status change can only CLOSE a published exam — never publish", async () => {
    const { service, examUpdateMany } = makeService({
      exam: { ...draftExam, status: "PUBLISHED", answerRelease: "HIDDEN", answersReleasedAt: null, classId: null, questionCount: 5, durationMinutes: 30, startAt: new Date(), endAt: new Date() },
    });
    await service.setExamStatus(admin(), "e1", "CLOSED");
    expect(examUpdateMany).toHaveBeenCalledWith({
      where: { id: "e1", status: "PUBLISHED" },
      data: { status: "CLOSED" },
    });
  });
});

describe("CbtService — gated answer-key release", () => {
  const closedExam = {
    id: "e1", title: "Mock", bankId: "b1", createdById: "t1", status: "CLOSED",
    answerRelease: "HIDDEN", answersReleasedAt: null,
    endAt: new Date(Date.now() - 3_600_000),
  };

  it("release can't be requested while the exam window is still open", async () => {
    const { service } = makeService({
      exam: { ...closedExam, status: "PUBLISHED", endAt: new Date(Date.now() + 3_600_000) },
    });
    await expect(service.requestAnswerRelease(teacher("t1"), "e1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("requestAnswerRelease claims the key and routes a CBT_ANSWER_RELEASE request to the principal", async () => {
    const { service, workflow, examUpdateMany } = makeService({ exam: closedExam });
    const res = await service.requestAnswerRelease(teacher("t1"), "e1");
    expect(res).toEqual({ pendingApproval: true, requestId: "wf1" });
    expect(examUpdateMany).toHaveBeenCalledWith({
      where: { id: "e1", answerRelease: "HIDDEN" },
      data: { answerRelease: "REQUESTED" },
    });
    const args = (workflow.createRequest as jest.Mock).mock.calls[0][1];
    expect(args.type).toBe("CBT_ANSWER_RELEASE");
    expect(args.stages).toEqual([
      expect.objectContaining({ key: "PRINCIPAL", permission: "workflow.review.principal" }),
    ]);
  });

  it("a second request is refused once the key is already requested/released", async () => {
    const { service } = makeService({ exam: { ...closedExam, answerRelease: "REQUESTED" }, examUpdateCount: 0 });
    await expect(service.requestAnswerRelease(teacher("t1"), "e1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("the finalized reactor releases the key on APPROVED (stamped) and hides it again on REJECTED", async () => {
    const { tx, examUpdateMany, finalized } = makeService({});
    await finalized(tx, {
      id: "wf1", schoolId: "A", type: "CBT_ANSWER_RELEASE", state: "APPROVED", payload: { examId: "e1" }, initiatorId: "t1",
    });
    expect(examUpdateMany).toHaveBeenCalledWith({
      where: { id: "e1", answerRelease: "REQUESTED" },
      data: { answerRelease: "RELEASED", answersReleasedAt: expect.any(Date) },
    });
    await finalized(tx, {
      id: "wf2", schoolId: "A", type: "CBT_ANSWER_RELEASE", state: "REJECTED", payload: { examId: "e1" }, initiatorId: "t1",
    });
    expect(examUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "e1", answerRelease: "REQUESTED" },
      data: { answerRelease: "HIDDEN" },
    });
  });

  it("a finished sitting shows the score but withholds every answerIndex until the key is RELEASED", async () => {
    const base = {
      sitting: {
        id: "s1", examId: "e1", studentId: "stu1", status: "SUBMITTED",
        startedAt: new Date(), submittedAt: new Date(),
        questionIds: ["q1"], answers: { q1: 1 }, score: 1, total: 1,
      },
      questions: [{ id: "q1", prompt: "2+2?", choices: ["3", "4"], answerIndex: 1 }],
    };
    const hidden = makeService({
      ...base,
      exam: { id: "e1", title: "Mock", durationMinutes: 30, endAt: new Date(), answerRelease: "HIDDEN" },
    });
    const viewHidden = await hidden.service.getSitting(teacher("stu1"), "s1");
    expect(viewHidden.score).toBe(1);
    expect(viewHidden.answersReleased).toBe(false);
    expect(viewHidden.questions[0]!.answerIndex).toBeNull();

    const released = makeService({
      ...base,
      exam: { id: "e1", title: "Mock", durationMinutes: 30, endAt: new Date(), answerRelease: "RELEASED" },
    });
    const viewReleased = await released.service.getSitting(teacher("stu1"), "s1");
    expect(viewReleased.answersReleased).toBe(true);
    expect(viewReleased.questions[0]!.answerIndex).toBe(1);
  });
});
