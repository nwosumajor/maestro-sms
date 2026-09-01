// =============================================================================
// ScholarshipAdminService — the cross-tenant review queue is AUDITED
// =============================================================================
// GOLDEN RULE #5. This read returns up to 500 applications from EVERY school
// with the pupil's name, their guardian's name, and the `signals` snapshot:
// published grade average, attendance, and outstanding fees. A minor's academic
// and financial record, read across the tenant boundary by the platform.
//
// Every MUTATION on this service already audited; the read was the exception,
// and the controller discarded the principal entirely (`_p`) so nothing reached
// the service to log with. Same defect and same fix as
// OperatorUserService.listUsers.
// =============================================================================

import { ScholarshipAdminService } from "../../src/scholarship/scholarship-admin.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

// Bcrypt at cost factor 10 dominates this suite's runtime — that is the security
// parameter doing its job, not slow code, so the timeout moves rather than the
// cost. At the 5s default these pass alone and fail under full-suite
// parallelism, which teaches people to re-run a red suite instead of reading it.
jest.setTimeout(60_000);


const owner: Principal = {
  schoolId: "platform-org",
  userId: "owner-1",
  roles: ["super_admin"],
  permissions: ["scholarship.admin"],
};

function makeService(rows: Array<Record<string, unknown>>) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const client = {
    scholarshipApplication: { findMany: jest.fn().mockResolvedValue(rows) },
    // Every real PrismaClient has this. The capped counts beside the page are
    // raw SQL — the cap is applied as a LIMIT inside a subquery rather than by
    // counting rows in Node, which measured 250 ms against 2.4 ms at volume.
    $queryRaw: jest.fn().mockResolvedValue([{ n: BigInt(rows.length) }]),
    scholarshipProgram: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "stu-1", name: "Ada Pupil" }]) },
    school: { findMany: jest.fn().mockResolvedValue([{ id: "school-A", name: "St Anne's" }]) },
  };
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn({} as TenantTx) };
  const service = new ScholarshipAdminService(
    db as never,
    audit as never,
    { client } as never,
    { enqueue: jest.fn() } as never,
    // Entitled by default: this suite is about auditing, not about which
    // schools hold the CBT module.
    { isEnabled: jest.fn().mockResolvedValue(true) } as never,
  );
  return { service, audit, client };
}

const application = (over: Record<string, unknown> = {}) => ({
  id: "app-1",
  programId: "prog-1",
  schoolId: "school-A",
  studentId: "stu-1",
  applicantId: "par-1",
  applicantRole: "parent",
  answers: null,
  signals: { gradeAvg: 74, attendancePct: 91, outstandingFeesMinor: 250000 },
  status: "SUBMITTED",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe("ScholarshipAdminService cross-tenant queue", () => {
  it("AUDITS the view, with counts and filters and never a pupil's name", async () => {
    const { service, audit } = makeService([application(), application({ id: "app-2", schoolId: "school-B" })]);
    await service.listApplications(owner, { status: "SUBMITTED" });
    const entry = audit.record.mock.calls.at(-1)?.[0];
    expect(entry).toMatchObject({
      action: "scholarship.applications.view",
      actorId: "owner-1",
      metadata: { count: 2, status: "SUBMITTED", schools: 2 },
    });
    // The audit log must never become a second copy of what it is recording:
    // no pupil name, and none of the financial/academic signal values.
    expect(JSON.stringify(entry)).not.toMatch(/Ada Pupil|250000|gradeAvg/);
  });

  // A search that found nothing is still a search — and the early return for an
  // empty result set is exactly where an audit call is easy to place wrongly.
  it("audits an EMPTY queue too", async () => {
    const { service, audit } = makeService([]);
    // A PAGE, not a bare array — the queue used to return `take: 500` with no
    // total and no paging, so the 4,500 an operator could not see were the
    // families who had waited longest. An empty PAGE must still carry the
    // backlog honestly rather than looking like an empty queue.
    await expect(service.listApplications(owner, {})).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
      undecidedTotal: 0,
      hasMore: false,
      countCap: 10_000,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "scholarship.applications.view", metadata: expect.objectContaining({ count: 0 }) }),
      expect.anything(),
    );
  });
});
