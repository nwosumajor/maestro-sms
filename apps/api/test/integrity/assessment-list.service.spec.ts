// =============================================================================
// AssessmentListService — who sees which assessments
// =============================================================================
// The listing is relationship-scoped: whole-school staff see every assessment,
// a teacher sees the ones they created or whose class they teach, a student the
// ones for classes they're enrolled in. In-memory fakes (no DB).
//
// The set of whole-school roles here had drifted from its two siblings in the
// same module (IntegrityReportService, ExemptionService), which is how a
// PRINCIPAL ended up able to read the integrity report for a submission and
// grant an exemption on it, while /assessments rendered empty for them.
// =============================================================================

import { AssessmentListService } from "../../src/integrity/assessment-list.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const ROWS = [
  { id: "a-1", title: "Essay", description: null, classId: "c-1", createdById: "someone-else", integrityEnabled: true, fileUploadEnabled: false, createdAt: new Date() },
];

function makeService() {
  const assessmentFindMany = jest.fn().mockResolvedValue(ROWS);
  const classTeacherFindMany = jest.fn().mockResolvedValue([]);
  const enrollmentFindMany = jest.fn().mockResolvedValue([]);
  const tx = {
    // The list is a PAGE now: rows plus how many match, so a truncated view
    // cannot read as the complete answer.
    assessment: { findMany: assessmentFindMany, count: jest.fn().mockResolvedValue(1) },
    classTeacher: { findMany: classTeacherFindMany, findFirst: jest.fn().mockResolvedValue(null) },
    enrollment: { findMany: enrollmentFindMany },
    class: { findMany: jest.fn().mockResolvedValue([{ id: "c-1", name: "JSS2A" }]) },
    // The count is a grouped COUNT and the caller's own status a targeted read —
    // the list must never hydrate every submission just to add them up.
    submission: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([{ assessmentId: "a-1", _count: { _all: 27 } }]),
    },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const service = new AssessmentListService(db as never, { record: jest.fn() } as never);
  return { service, assessmentFindMany, classTeacherFindMany, tx };
}

const principal = (roles: string[]): Principal => ({
  schoolId: "school-A",
  userId: "u-1",
  roles,
  permissions: [],
});

/** The school-wide path queries with an EMPTY where; a scoped one ORs membership. */
const whereOf = (m: jest.Mock) => (m.mock.calls[0][0] as { where: Record<string, unknown> }).where;

describe("AssessmentListService scoping", () => {
  it("school_admin sees every assessment (no membership filter)", async () => {
    const { service, assessmentFindMany, classTeacherFindMany } = makeService();
    const out = await service.listAssessments(principal(["school_admin"]));
    expect(out.items).toHaveLength(1);
    expect(whereOf(assessmentFindMany)).toEqual({});
    expect(classTeacherFindMany).not.toHaveBeenCalled();
  });

  // A principal holds assessment.read AND integrity.report.read, and is already
  // school-wide in IntegrityReportService and ExemptionService. Listing was the
  // odd one out, so the module let them judge an assessment they could not find.
  it("principal sees every assessment — same as the report + exemption reads", async () => {
    const { service, assessmentFindMany } = makeService();
    const out = await service.listAssessments(principal(["principal"]));
    expect(out.items).toHaveLength(1);
    expect(whereOf(assessmentFindMany)).toEqual({});
  });

  it("junior_admin (records tier) sees every assessment", async () => {
    const { service, assessmentFindMany } = makeService();
    const out = await service.listAssessments(principal(["junior_admin"]));
    expect(out.items).toHaveLength(1);
    expect(whereOf(assessmentFindMany)).toEqual({});
  });

  it("a teacher is still narrowed to what they created or teach", async () => {
    const { service, assessmentFindMany, classTeacherFindMany } = makeService();
    await service.listAssessments(principal(["teacher"]));
    expect(classTeacherFindMany).toHaveBeenCalled();
    expect(whereOf(assessmentFindMany)).toHaveProperty("OR");
  });

  it("a class filter can only ever NARROW a school-wide caller, not widen a scoped one", async () => {
    const { service, assessmentFindMany } = makeService();
    await service.listAssessments(principal(["teacher"]), { classId: "c-9" });
    const where = whereOf(assessmentFindMany) as { AND: [{ OR: unknown }, { classId: string }] };
    // The membership OR survives as the first AND term — the filter is ANDed on
    // top of the scope rather than replacing it.
    expect(where.AND[0]).toHaveProperty("OR");
    expect(where.AND[1]).toEqual({ classId: "c-9" });
  });
});

// ===========================================================================
// The counts come from Postgres, not from Node
// ===========================================================================
// This used to load EVERY submission for every listed assessment — at LIST_CAP
// (500) assessments in a 30-pupil class, 15,000 rows hydrated to yield 500
// numbers, on the page a teacher opens to find today's work.
describe("AssessmentListService submission counts", () => {
  it("groups the count in SQL and asks only for the caller's own submissions", async () => {
    const { service, tx } = makeService();
    const out = await service.listAssessments(principal(["school_admin"]));
    expect(out.items[0].submissionCount).toBe(27);

    const groupBy = tx.submission.groupBy as jest.Mock;
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy.mock.calls[0][0]).toMatchObject({ by: ["assessmentId"], _count: { _all: true } });

    // The only findMany against submissions is the caller's OWN — narrowed by
    // studentId, never a whole-table read the service then filters in memory.
    const findMany = tx.submission.findMany as jest.Mock;
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.studentId).toBe("u-1");
  });
});
