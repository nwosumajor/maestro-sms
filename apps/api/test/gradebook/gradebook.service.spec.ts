// =============================================================================
// GradebookService — grading scope + read scope unit tests
// =============================================================================

import { GradebookService } from "../../src/gradebook/gradebook.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: {
  submission?: Record<string, unknown> | null;
  assessment?: Record<string, unknown> | null;
  classTeacher?: Record<string, unknown> | null;
  grade?: Record<string, unknown> | null;
  parentChild?: Record<string, unknown> | null;
}) {
  const upsert = jest.fn(({ create }: { create: Record<string, unknown> }) =>
    Promise.resolve({ id: "g1", ...create }),
  );
  const tx = {
    submission: {
      findFirst: jest.fn().mockResolvedValue(over.submission ?? null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    assessment: { findFirst: jest.fn().mockResolvedValue(over.assessment ?? null) },
    classTeacher: { findFirst: jest.fn().mockResolvedValue(over.classTeacher ?? null) },
    parentChild: { findFirst: jest.fn().mockResolvedValue(over.parentChild ?? null) },
    grade: {
      upsert,
      findUnique: jest.fn().mockResolvedValue(over.grade ?? null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new GradebookService(db as never, audit as never), upsert, audit };
}

const p = (roles: string[] = ["teacher"], userId = "teacher-1"): Principal => ({
  schoolId: "A",
  userId,
  roles,
  permissions: [],
});

describe("GradebookService", () => {
  it("rejects score > maxScore", async () => {
    const { service } = makeService({});
    await expect(
      service.gradeSubmission(p(), "s1", { score: 110, maxScore: 100 }),
    ).rejects.toThrow(/between 0 and maxScore/i);
  });

  it("a teacher of the assessment's class can grade it (and it's audited)", async () => {
    const { service, upsert, audit } = makeService({
      submission: { id: "s1", assessmentId: "a1" },
      assessment: { createdById: "other", classId: "c1" },
      classTeacher: { id: "ct1" },
    });
    await service.gradeSubmission(p(), "s1", { score: 80, maxScore: 100, status: "PUBLISHED" });
    expect(upsert).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "gradebook.grade.set" }),
      expect.anything(),
    );
  });

  it("a teacher who neither teaches the class nor authored it gets 404", async () => {
    const { service } = makeService({
      submission: { id: "s1", assessmentId: "a1" },
      assessment: { createdById: "other", classId: "c1" },
      classTeacher: null,
    });
    await expect(
      service.gradeSubmission(p(), "s1", { score: 80, maxScore: 100 }),
    ).rejects.toThrow(/not found/i);
  });

  it("a student sees their own PUBLISHED grade but not a DRAFT", async () => {
    const published = makeService({
      submission: { id: "s1", assessmentId: "a1", studentId: "stu-1" },
      assessment: { createdById: "other", classId: "c1" },
      classTeacher: null,
      grade: { id: "g1", status: "PUBLISHED", score: 80 },
    });
    await expect(
      published.service.getSubmissionGrade(p(["student"], "stu-1"), "s1"),
    ).resolves.toMatchObject({ status: "PUBLISHED" });

    const draft = makeService({
      submission: { id: "s1", assessmentId: "a1", studentId: "stu-1" },
      assessment: { createdById: "other", classId: "c1" },
      classTeacher: null,
      grade: { id: "g1", status: "DRAFT", score: 80 },
    });
    await expect(
      draft.service.getSubmissionGrade(p(["student"], "stu-1"), "s1"),
    ).rejects.toThrow(/not found/i);
  });

  it("a parent sees their child's PUBLISHED grade", async () => {
    const { service } = makeService({
      submission: { id: "s1", assessmentId: "a1", studentId: "child-1" },
      assessment: { createdById: "other", classId: "c1" },
      classTeacher: null,
      grade: { id: "g1", status: "PUBLISHED", score: 80 },
      parentChild: { id: "pc1" },
    });
    await expect(
      service.getSubmissionGrade(p(["parent"], "parent-1"), "s1"),
    ).resolves.toMatchObject({ status: "PUBLISHED" });
  });
});
