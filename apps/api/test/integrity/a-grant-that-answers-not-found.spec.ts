/**
 * A role that holds the permission and is refused by every row.
 *
 * `integrity.report.read` is granted to board, junior_admin, principal,
 * school_admin and teacher. The report service's own SCHOOL_WIDE_ROLES was
 * {school_admin, principal}, and junior_admin is a teacher of nothing — so every
 * submission answered "Submission not found".
 *
 * Measured live, one junior_admin, one submission:
 *   GET /assessments            200, 30 assessments
 *   GET .../integrity-report    404 "Submission not found"
 *   GET /integrity/exemptions   200, []          (scoped to nothing)
 *
 * THE ARGUMENT WAS ALREADY WRITTEN DOWN TWICE AND APPLIED TO ONE OF THREE
 * SERVICES. `IntegrityReportService`'s set was widened for PRINCIPAL with the
 * dead-grant reasoning verbatim ("otherwise the grant is dead"), and
 * `AssessmentListService`'s was widened for junior_admin citing this very
 * permission ("junior_admin holds assessment.read AND integrity.report.read on
 * the same footing"). The result is the reverse of the sentence that fix used:
 * the module let them FIND an assessment they could not judge.
 *
 * Live after: junior_admin 200 with the signals; pupil 403, parent 403, teacher
 * 200 — all unchanged.
 */
import { IntegrityReportService } from "../../src/integrity/integrity-report.service";
import { ExemptionService } from "../../src/integrity/exemption.service";
import type { Principal, TenantTx } from "../../src/integrity/integrity.foundation";
import { INTEGRITY_PERMISSIONS, ROLE_PERMISSIONS } from "@sms/types";

const SUB = { id: "sub-1", assessmentId: "a-1", studentId: "stu-1", status: "SUBMITTED", submittedAt: new Date() };

function makeTx() {
  return {
    submission: { findFirst: jest.fn().mockResolvedValue(SUB) },
    // Created by somebody else, and the caller teaches nothing: the only way
    // through is being school-wide.
    assessment: { findFirst: jest.fn().mockResolvedValue({ id: "a-1", title: "Essay", createdById: "someone-else", classId: "c-1" }) },
    classTeacher: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    integritySignal: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "stu-1" }) },
    studentIntegrityExemption: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
}

const as = (roles: string[]): Principal => ({
  schoolId: "A", userId: "u-1", roles,
  permissions: [INTEGRITY_PERMISSIONS.REPORT_READ, INTEGRITY_PERMISSIONS.EXEMPTION_READ],
});

function reportService(tx: TenantTx) {
  return new IntegrityReportService(
    { runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

describe("a grant that answers not found", () => {
  it("lets junior_admin read an integrity report school-wide", async () => {
    const svc = reportService(makeTx());
    const report = await svc.getSubmissionReport(as(["junior_admin"]), "sub-1");
    expect(report.submissionId).toBe("sub-1");
  });

  it("still 404s a teacher who neither created nor teaches it", async () => {
    // The relationship scoping this widening must not weaken.
    const svc = reportService(makeTx());
    await expect(svc.getSubmissionReport(as(["teacher"]), "sub-1")).rejects.toThrow(/not found/i);
  });

  it("leaves board refused, deliberately", async () => {
    // board holds the permission and is in no wide set in this module. Widening
    // a governance tier onto a named child's paste and focus telemetry is a
    // policy decision, not a drifted set — Golden Rule #7 until somebody takes it.
    const svc = reportService(makeTx());
    await expect(svc.getSubmissionReport(as(["board"]), "sub-1")).rejects.toThrow(/not found/i);
  });

  it("keeps the exemption service's promise to match the report service exactly", async () => {
    // Its comment says "matching IntegrityReportService's SCHOOL_WIDE_ROLES
    // exactly". A promise of that kind is what drifts when one side is edited.
    const rep = require("fs").readFileSync(require("path").join(__dirname, "../../src/integrity/integrity-report.service.ts"), "utf8");
    const exe = require("fs").readFileSync(require("path").join(__dirname, "../../src/integrity/exemption.service.ts"), "utf8");
    const set = (src: string) => {
      const m = /const SCHOOL_WIDE_ROLES = new Set\(\[([^\]]*)\]\)/.exec(src);
      if (!m) throw new Error("SCHOOL_WIDE_ROLES not found — the gate is looking in the wrong place");
      return m[1].split(",").map((x) => x.trim().replace(/["']/g, "")).filter(Boolean).sort();
    };
    expect(set(exe)).toEqual(set(rep));
    expect(set(rep)).toContain("junior_admin");
  });

  it("every role granted integrity.report.read can actually reach a report, or is named", async () => {
    // The check that would have caught this: the grant and the row scope are two
    // halves of one permission, and only the seed is visible in a review screen.
    const granted = Object.entries(ROLE_PERMISSIONS)
      .filter(([, perms]) => (perms as readonly string[]).includes(INTEGRITY_PERMISSIONS.REPORT_READ))
      .map(([role]) => role);
    // teacher reaches reports by relationship; board is knowingly refused.
    const byRelationship = new Set(["teacher", "board"]);
    for (const role of granted) {
      if (byRelationship.has(role)) continue;
      const svc = reportService(makeTx());
      await expect(svc.getSubmissionReport(as([role]), "sub-1")).resolves.toBeDefined();
    }
    expect(granted.length).toBeGreaterThan(2);
  });
});
