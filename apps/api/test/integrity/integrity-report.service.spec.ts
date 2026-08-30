// =============================================================================
// IntegrityReportService unit tests
// =============================================================================
// Covers: permission re-assertion (403), teacher ownership scoping (404 for
// another teacher's submission), school_admin override, and that every read is
// audit-logged (Golden Rule #5).
// =============================================================================

import { IntegrityReportService } from "../../src/integrity/integrity-report.service";
import type { Principal, TenantTx } from "../../src/integrity/integrity.foundation";
import { INTEGRITY_PERMISSIONS } from "@sms/types";

/** `teaches` names the CLASS TEACHER of c-1, or null if it has none. */
function makeTx(submission: unknown, assessment: unknown, teaches: string | null = null) {
  return {
    submission: { findFirst: jest.fn().mockResolvedValue(submission) },
    assessment: { findFirst: jest.fn().mockResolvedValue(assessment) },
    // One definition of who teaches a class (common/teaches.ts) reads the
    // class SUPERVISOR and the subject offerings too — every real TenantTx
    // answers all three.
    // HONOURS THE WHERE: only the named co-teacher runs c-1. Answering every
    // caller with the class would make the "neither created nor teaches it"
    // case impossible to express.
    class: {
      findMany: jest.fn(({ where }: { where?: { supervisorId?: string } } = {}) =>
        Promise.resolve(where?.supervisorId === teaches ? [{ id: "c-1" }] : []),
      ),
    },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    integritySignal: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
}

function makeService(tx: TenantTx) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const db = { runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  return { service: new IntegrityReportService(db as never, audit as never), audit };
}

const SUB = { id: "sub-1", assessmentId: "a-1", studentId: "stu-1", status: "SUBMITTED", submittedAt: new Date() };

const teacher = (id: string): Principal => ({
  schoolId: "A", userId: id, roles: ["teacher"],
  permissions: [INTEGRITY_PERMISSIONS.REPORT_READ],
});

describe("IntegrityReportService", () => {
  it("403s when the caller lacks integrity.report.read", async () => {
    const tx = makeTx(SUB, { id: "a-1", title: "T", createdById: "teacher-1" });
    const { service } = makeService(tx);
    const principal: Principal = { schoolId: "A", userId: "x", roles: ["teacher"], permissions: [] };
    await expect(service.getSubmissionReport(principal, "sub-1")).rejects.toThrow();
  });

  it("returns the report for the owning teacher and audits the read", async () => {
    const tx = makeTx(SUB, { id: "a-1", title: "Essay", createdById: "teacher-1" });
    const { service, audit } = makeService(tx);
    const report = await service.getSubmissionReport(teacher("teacher-1"), "sub-1");
    expect(report.assessmentTitle).toBe("Essay");
    expect(report.disclaimer).toMatch(/no automatic action/i);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "integrity.report.read" }),
      expect.anything(),
    );
  });

  it("404s for a teacher who does not own the assessment (no leak)", async () => {
    const tx = makeTx(SUB, { id: "a-1", title: "T", createdById: "teacher-1" });
    const { service } = makeService(tx);
    await expect(service.getSubmissionReport(teacher("teacher-2"), "sub-1")).rejects.toThrow(/not found/i);
  });

  it("allows a co-teacher of the assessment's class (not the creator) to read the report", async () => {
    // teacher-2 didn't CREATE a-1 but teaches its class — matches the file rule.
    const tx = makeTx(
      SUB,
      { id: "a-1", title: "T", createdById: "teacher-1", classId: "c-1" },
      "teacher-2", // teacher-2 is the CLASS TEACHER of c-1
    );
    const { service } = makeService(tx);
    const report = await service.getSubmissionReport(teacher("teacher-2"), "sub-1");
    expect(report.submissionId).toBe("sub-1");
  });

  it("still 404s a teacher who neither created the assessment NOR teaches its class", async () => {
    const tx = makeTx(SUB, { id: "a-1", title: "T", createdById: "teacher-1", classId: "c-1" }, null);
    const { service } = makeService(tx);
    await expect(service.getSubmissionReport(teacher("stranger"), "sub-1")).rejects.toThrow(/not found/i);
  });

  it("allows a school_admin to read any submission in the tenant", async () => {
    const tx = makeTx(SUB, { id: "a-1", title: "T", createdById: "teacher-1" });
    const { service } = makeService(tx);
    const admin: Principal = {
      schoolId: "A", userId: "admin-1", roles: ["school_admin"],
      permissions: [INTEGRITY_PERMISSIONS.REPORT_READ],
    };
    const report = await service.getSubmissionReport(admin, "sub-1");
    expect(report.submissionId).toBe("sub-1");
  });

  it("allows a principal (oversight tier) to read any submission it did not create", async () => {
    // principal holds integrity.report.read but never creates assessments; the
    // school-wide short-circuit must let it through (else the grant is dead).
    const tx = makeTx(SUB, { id: "a-1", title: "T", createdById: "teacher-1" });
    const { service } = makeService(tx);
    const principal: Principal = {
      schoolId: "A", userId: "principal-1", roles: ["principal"],
      permissions: [INTEGRITY_PERMISSIONS.REPORT_READ],
    };
    const report = await service.getSubmissionReport(principal, "sub-1");
    expect(report.submissionId).toBe("sub-1");
  });
});
