// =============================================================================
// TermResultService — term-weighted grading scope + server-side computation +
// the GRADE_PUBLISH maker-checker (head teacher → principal).
// =============================================================================

import { TermResultService } from "../../src/gradebook/term-result.service";
import type { FinalizedHandler } from "../../src/workflow/workflow-hooks.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: {
  term?: Record<string, unknown> | null;
  klass?: Record<string, unknown> | null;
  subject?: Record<string, unknown> | null;
  classSubjectTeacher?: Record<string, unknown> | null;
  enrollment?: Record<string, unknown> | null;
  enrollments?: Record<string, unknown>[];
  student?: Record<string, unknown> | null;
  session?: Record<string, unknown> | null;
  parentChild?: Record<string, unknown> | null;
  classTeacher?: Record<string, unknown> | null;
  supervisorClass?: Record<string, unknown> | null;
  results?: Record<string, unknown>[];
  existingResult?: Record<string, unknown> | null;
  approvedSelections?: { studentId: string; subjectIds: string[] }[];
  updateManyCount?: number;
}) {
  const upsert = jest.fn(({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) =>
    Promise.resolve({ id: "sr1", gradedAt: new Date(), ...create, ...update }),
  );
  const updateMany = jest.fn().mockResolvedValue({ count: over.updateManyCount ?? 0 });
  const tx = {
    term: { findFirst: jest.fn().mockResolvedValue(over.term ?? null), findMany: jest.fn().mockResolvedValue([]) },
    class: {
      findFirst: jest
        .fn()
        // getGradingRoster looks up the class; canReadReport looks up a supervised class.
        .mockImplementation((args: { where?: { supervisorId?: string } }) =>
          Promise.resolve(args?.where?.supervisorId ? (over.supervisorClass ?? null) : (over.klass ?? null)),
        ),
    },
    subject: {
      findFirst: jest.fn().mockResolvedValue(over.subject ?? null),
      findMany: jest.fn().mockResolvedValue((over.results ?? []).map((r) => ({ id: (r as { subjectId: string }).subjectId, name: "Math" }))),
    },
    classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue(over.classSubjectTeacher ?? null) },
    classTeacher: { findFirst: jest.fn().mockResolvedValue(over.classTeacher ?? null) },
    enrollment: {
      findFirst: jest.fn().mockResolvedValue(over.enrollment ?? null),
      // Default: when a single enrollment is modelled, the class roster
      // contains that student (subjectTakers falls back to enrollments).
      findMany: jest.fn().mockResolvedValue(
        over.enrollments ?? (over.enrollment ? [{ studentId: "stu1" }] : []),
      ),
    },
    subjectSelection: { findMany: jest.fn().mockResolvedValue(over.approvedSelections ?? []) },
    user: {
      findFirst: jest.fn().mockResolvedValue(over.student ?? null),
      findMany: jest.fn().mockResolvedValue(over.student ? [over.student] : []),
    },
    studentProfile: { findMany: jest.fn().mockResolvedValue([]) },
    academicSession: { findFirst: jest.fn().mockResolvedValue(over.session ?? null) },
    parentChild: { findFirst: jest.fn().mockResolvedValue(over.parentChild ?? null) },
    subjectResult: {
      upsert,
      updateMany,
      findMany: jest.fn().mockResolvedValue(over.results ?? []),
      // upsertResult consults the existing row's status for the edit guards.
      findFirst: jest.fn().mockResolvedValue(over.existingResult ?? null),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const workflow = {
    createRequest: jest.fn().mockResolvedValue({ id: "wf1" }),
    submit: jest.fn().mockResolvedValue(undefined),
  };
  // Capture the finalized reactor so tests can invoke it directly.
  let finalized: FinalizedHandler | undefined;
  const hooks = { onFinalized: (h: FinalizedHandler) => { finalized = h; } };
  const service = new TermResultService(db as never, audit as never, workflow as never, hooks as never);
  return { service, tx, upsert, updateMany, audit, workflow, finalized: finalized! };
}

const p = (roles: string[] = ["teacher"], userId = "teacher-1"): Principal => ({
  schoolId: "A",
  userId,
  roles,
  permissions: [],
});

const baseGrade = {
  term: { id: "t1", sessionId: "sess1" },
  subject: { id: "sub1", name: "Math" },
  klass: { id: "c1", name: "JSS1" },
};

describe("TermResultService — grading", () => {
  it("the assigned class-subject teacher can grade an enrolled student, and it's audited", async () => {
    const { service, upsert, audit } = makeService({
      ...baseGrade,
      classSubjectTeacher: { id: "cst1" },
      enrollment: { id: "e1" },
      student: { id: "stu1", name: "Ada" },
    });
    const res = await service.upsertResult(p(), {
      termId: "t1", classId: "c1", subjectId: "sub1", studentId: "stu1",
      exam: 45, midterm: 12, assignment: 5, classNote: 4,
    });
    // Raw marks summed (each out of its max): 45 + 12 + 5 + 4 = 66 — computed server-side.
    expect(res.total).toBe(66);
    expect(res.grade).toBe("B");
    expect(upsert).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "gradebook.term.grade.set" }),
      expect.anything(),
    );
  });

  it("a teacher not assigned to the class-subject gets 404 (not 403)", async () => {
    const { service } = makeService({
      ...baseGrade,
      classSubjectTeacher: null, // not the assigned teacher
      enrollment: { id: "e1" },
      student: { id: "stu1", name: "Ada" },
    });
    await expect(
      service.upsertResult(p(), {
        termId: "t1", classId: "c1", subjectId: "sub1", studentId: "stu1", exam: 50,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("grading a student not enrolled in the class is rejected", async () => {
    const { service } = makeService({
      ...baseGrade,
      classSubjectTeacher: { id: "cst1" },
      enrollment: null, // not enrolled
    });
    await expect(
      service.upsertResult(p(), {
        termId: "t1", classId: "c1", subjectId: "sub1", studentId: "stranger", exam: 50,
      }),
    ).rejects.toThrow(/not enrolled/i);
  });

  it("a component mark above its own maximum is rejected (exam max 60)", async () => {
    const { service } = makeService({
      ...baseGrade,
      classSubjectTeacher: { id: "cst1" },
      enrollment: { id: "e1" },
      student: { id: "stu1", name: "Ada" },
    });
    await expect(
      service.upsertResult(p(), {
        termId: "t1", classId: "c1", subjectId: "sub1", studentId: "stu1", exam: 120,
      }),
    ).rejects.toThrow(/between 0 and 60/i);
  });

  it("a component mark above a SMALLER maximum is rejected (midterm max 20)", async () => {
    const { service } = makeService({
      ...baseGrade,
      classSubjectTeacher: { id: "cst1" },
      enrollment: { id: "e1" },
      student: { id: "stu1", name: "Ada" },
    });
    await expect(
      service.upsertResult(p(), {
        termId: "t1", classId: "c1", subjectId: "sub1", studentId: "stu1", midterm: 25,
      }),
    ).rejects.toThrow(/between 0 and 20/i);
  });

  it("editing is blocked while the batch awaits head-teacher/principal approval", async () => {
    const { service } = makeService({
      ...baseGrade,
      classSubjectTeacher: { id: "cst1" },
      enrollment: { id: "e1" },
      student: { id: "stu1", name: "Ada" },
      existingResult: { status: "PENDING_APPROVAL" },
    });
    await expect(
      service.upsertResult(p(), {
        termId: "t1", classId: "c1", subjectId: "sub1", studentId: "stu1", exam: 55,
      }),
    ).rejects.toThrow(/awaiting head-teacher\/principal approval/i);
  });

  it("APPROVED selections narrow who can be graded: a non-taker is refused", async () => {
    const { service } = makeService({
      ...baseGrade,
      classSubjectTeacher: { id: "cst1" },
      enrollment: { id: "e1" },
      student: { id: "stu1", name: "Ada" },
      // Selections govern this class+term, and stu1's approved pick does NOT
      // include sub1 — grading them into it must fail.
      approvedSelections: [{ studentId: "stu1", subjectIds: ["other-subject"] }],
    });
    await expect(
      service.upsertResult(p(), {
        termId: "t1", classId: "c1", subjectId: "sub1", studentId: "stu1", exam: 50,
      }),
    ).rejects.toThrow(/does not offer this subject/i);
  });

  it("APPROVED selections narrow the roster to students whose pick includes the subject", async () => {
    const { service } = makeService({
      ...baseGrade,
      classSubjectTeacher: { id: "cst1" },
      enrollments: [{ studentId: "stu1" }, { studentId: "stu2" }],
      student: { id: "stu1", name: "Ada" },
      approvedSelections: [
        { studentId: "stu1", subjectIds: ["sub1"] },
        { studentId: "stu2", subjectIds: ["other-subject"] },
      ],
    });
    const roster = await service.getGradingRoster(p(), { classId: "c1", subjectId: "sub1", termId: "t1" });
    expect(roster.students.map((s) => s.studentId)).toEqual(["stu1"]);
  });

  it("editing a PUBLISHED grade reverts it to DRAFT (re-approval required)", async () => {
    const { service, upsert } = makeService({
      ...baseGrade,
      classSubjectTeacher: { id: "cst1" },
      enrollment: { id: "e1" },
      student: { id: "stu1", name: "Ada" },
      existingResult: { status: "PUBLISHED" },
    });
    await service.upsertResult(p(), {
      termId: "t1", classId: "c1", subjectId: "sub1", studentId: "stu1", exam: 55,
    });
    const call = upsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(call.update.status).toBe("DRAFT");
  });
});

describe("TermResultService — GRADE_PUBLISH maker-checker", () => {
  it("publish CLAIMS the draft batch and raises a head→principal workflow request", async () => {
    const { service, updateMany, workflow, audit } = makeService({
      ...baseGrade,
      classSubjectTeacher: { id: "cst1" },
      updateManyCount: 3,
    });
    const res = await service.publishResults(p(), { classId: "c1", subjectId: "sub1", termId: "t1" });
    expect(res).toEqual({ pendingApproval: true, requestId: "wf1", submitted: 3 });
    // Claimed, not published: DRAFT -> PENDING_APPROVAL.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "DRAFT" }), data: { status: "PENDING_APPROVAL" } }),
    );
    // The request rides the 2-stage chain (head teacher, then principal).
    const createArg = workflow.createRequest.mock.calls[0][1] as { type: string; stages: { key: string }[] };
    expect(createArg.type).toBe("GRADE_PUBLISH");
    expect(createArg.stages.map((s) => s.key)).toEqual(["HEAD", "PRINCIPAL"]);
    expect(workflow.submit).toHaveBeenCalledWith(expect.anything(), "wf1");
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "gradebook.term.publish.requested" }),
      expect.anything(),
    );
  });

  it("publish with no draft rows is rejected (already pending/published or nothing saved)", async () => {
    const { service, workflow } = makeService({
      ...baseGrade,
      classSubjectTeacher: { id: "cst1" },
      updateManyCount: 0,
    });
    await expect(
      service.publishResults(p(), { classId: "c1", subjectId: "sub1", termId: "t1" }),
    ).rejects.toThrow(/no draft grades/i);
    expect(workflow.createRequest).not.toHaveBeenCalled();
  });

  it("if raising the request fails, the claim is RELEASED back to DRAFT", async () => {
    const { service, updateMany, workflow } = makeService({
      ...baseGrade,
      classSubjectTeacher: { id: "cst1" },
      updateManyCount: 2,
    });
    workflow.createRequest.mockRejectedValueOnce(new Error("engine down"));
    await expect(
      service.publishResults(p(), { classId: "c1", subjectId: "sub1", termId: "t1" }),
    ).rejects.toThrow("engine down");
    // Second updateMany call is the compensating revert.
    const last = updateMany.mock.calls[updateMany.mock.calls.length - 1][0] as {
      where: Record<string, unknown>; data: Record<string, unknown>;
    };
    expect(last.where.status).toBe("PENDING_APPROVAL");
    expect(last.data.status).toBe("DRAFT");
  });

  it("the finalized hook publishes on APPROVED and reverts to DRAFT on REJECTED — only PENDING rows", async () => {
    const { tx, updateMany, finalized } = makeService({ updateManyCount: 3 });
    const base = {
      id: "wf1", schoolId: "A", type: "GRADE_PUBLISH",
      payload: { classId: "c1", subjectId: "sub1", termId: "t1" }, initiatorId: "teacher-1",
    };
    await finalized(tx, { ...base, state: "APPROVED" });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PENDING_APPROVAL" }),
        data: { status: "PUBLISHED" },
      }),
    );
    await finalized(tx, { ...base, state: "REJECTED" });
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PENDING_APPROVAL" }),
        data: { status: "DRAFT" },
      }),
    );
  });

  it("the finalized hook ignores other workflow types", async () => {
    const { tx, updateMany, finalized } = makeService({});
    await finalized(tx, {
      id: "wf2", schoolId: "A", type: "LEAVE", state: "APPROVED",
      payload: { classId: "c1", subjectId: "sub1", termId: "t1" }, initiatorId: "u1",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("TermResultService — report read scope", () => {
  const session = { id: "sess1", name: "2025/2026" };
  const student = { id: "stu1", name: "Ada" };

  it("a parent sees ONLY their child's PUBLISHED results", async () => {
    const publishedFindMany = jest.fn().mockResolvedValue([]);
    const { service } = makeService({
      session,
      student,
      parentChild: { id: "pc1" }, // is the parent of stu1
      enrollments: [],
    });
    // override findMany to assert the status filter
    (service as unknown as { db: { runAsTenant: unknown } }).db = {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) =>
        fn({
          academicSession: { findFirst: jest.fn().mockResolvedValue(session) },
          user: { findFirst: jest.fn().mockResolvedValue(student) },
          class: { findFirst: jest.fn().mockResolvedValue(null) },
          classTeacher: { findFirst: jest.fn().mockResolvedValue(null) },
          classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue(null) },
          enrollment: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
          parentChild: { findFirst: jest.fn().mockResolvedValue({ id: "pc1" }) },
          term: { findMany: jest.fn().mockResolvedValue([]) },
          subject: { findMany: jest.fn().mockResolvedValue([]) },
          subjectResult: { findMany: publishedFindMany },
        } as unknown as TenantTx),
    };
    await service.getStudentSessionReport(p(["parent"], "parent-1"), { studentId: "stu1", sessionId: "sess1" });
    expect(publishedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "PUBLISHED" }) }),
    );
  });

  it("an unrelated user (not staff, not parent, not the student) gets 404", async () => {
    const { service } = makeService({
      session,
      student,
      parentChild: null,
      enrollments: [],
    });
    await expect(
      service.getStudentSessionReport(p(["parent"], "stranger"), { studentId: "stu1", sessionId: "sess1" }),
    ).rejects.toThrow(/not found/i);
  });

  it("school_admin sees the report with DRAFT rows included (no status filter)", async () => {
    const allFindMany = jest.fn().mockResolvedValue([]);
    const { service } = makeService({ session, student });
    (service as unknown as { db: { runAsTenant: unknown } }).db = {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) =>
        fn({
          academicSession: { findFirst: jest.fn().mockResolvedValue(session) },
          user: { findFirst: jest.fn().mockResolvedValue(student) },
          class: { findFirst: jest.fn().mockResolvedValue(null) },
          classTeacher: { findFirst: jest.fn().mockResolvedValue(null) },
          classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue(null) },
          enrollment: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
          parentChild: { findFirst: jest.fn().mockResolvedValue(null) },
          term: { findMany: jest.fn().mockResolvedValue([]) },
          subject: { findMany: jest.fn().mockResolvedValue([]) },
          subjectResult: { findMany: allFindMany },
        } as unknown as TenantTx),
    };
    await service.getStudentSessionReport(p(["school_admin"], "admin-1"), { studentId: "stu1", sessionId: "sess1" });
    const callArg = allFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(callArg.where.status).toBeUndefined();
  });
});
