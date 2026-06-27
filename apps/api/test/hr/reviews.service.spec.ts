// =============================================================================
// HrReviewsService — appraisal lifecycle + disciplinary append-only log
// =============================================================================

import { HrReviewsService } from "../../src/hr/reviews.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function make(over: { appraisal?: Record<string, unknown> | null; disciplinaryCase?: Record<string, unknown> | null } = {}) {
  const appraisalUpdate = jest.fn((a: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "a1", userId: "u1", reviewerId: "r1", period: "2026-H1", status: "DRAFT", overallRating: null, summary: null, goals: null, acknowledgedAt: null, createdAt: new Date(), ...a.data }),
  );
  const entryCreate = jest.fn().mockResolvedValue({});
  const tx = {
    user: { findFirst: jest.fn().mockResolvedValue({ id: "u1", name: "Ada" }), findMany: jest.fn().mockResolvedValue([{ id: "u1", name: "Ada" }]) },
    appraisal: {
      create: jest.fn().mockResolvedValue({ id: "a1", userId: "u1", reviewerId: "r1", period: "2026-H1", status: "DRAFT", overallRating: null, summary: null, goals: null, acknowledgedAt: null, createdAt: new Date() }),
      findFirst: jest.fn().mockResolvedValue(over.appraisal ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      update: appraisalUpdate,
    },
    disciplinaryCase: {
      create: jest.fn().mockResolvedValue({ id: "c1", userId: "u1", title: "X", category: null, severity: "LOW", status: "OPEN", openedById: "hr1", createdAt: new Date() }),
      findFirst: jest.fn().mockResolvedValue(over.disciplinaryCase ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    disciplinaryEntry: { create: entryCreate, findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new HrReviewsService(db as never, audit as never), appraisalUpdate, entryCreate };
}

const p = (userId = "hr1"): Principal => ({ schoolId: "A", userId, roles: [], permissions: [] });

describe("HrReviewsService", () => {
  it("submitAppraisal moves DRAFT → SUBMITTED", async () => {
    const { service, appraisalUpdate } = make({ appraisal: { id: "a1", userId: "u1", status: "DRAFT" } });
    await service.submitAppraisal(p(), "a1");
    expect(appraisalUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "SUBMITTED" } }));
  });

  it("acknowledgeAppraisal: only the appraisee, only when SUBMITTED", async () => {
    const notOwner = make({ appraisal: { id: "a1", userId: "u1", status: "SUBMITTED" } });
    await expect(notOwner.service.acknowledgeAppraisal(p("someone-else"), "a1")).rejects.toThrow(/not found/i);

    const wrongState = make({ appraisal: { id: "a1", userId: "u1", status: "DRAFT" } });
    await expect(wrongState.service.acknowledgeAppraisal(p("u1"), "a1")).rejects.toThrow(/not awaiting/i);

    const ok = make({ appraisal: { id: "a1", userId: "u1", status: "SUBMITTED" } });
    await ok.service.acknowledgeAppraisal(p("u1"), "a1");
    expect(ok.appraisalUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACKNOWLEDGED", acknowledgedAt: expect.any(Date) }) }));
  });

  it("updateAppraisal refuses a non-DRAFT appraisal", async () => {
    const { service } = make({ appraisal: { id: "a1", userId: "u1", status: "SUBMITTED", period: "2026-H1", overallRating: null, summary: null, goals: null } });
    await expect(service.updateAppraisal(p(), "a1", { summary: "late" })).rejects.toThrow(/DRAFT/i);
  });

  it("addEntry appends to a disciplinary case", async () => {
    const { service, entryCreate } = make({ disciplinaryCase: { id: "c1", userId: "u1" } });
    await service.addEntry(p(), "c1", "Verbal warning issued");
    expect(entryCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ note: "Verbal warning issued", caseId: "c1" }) }));
  });
});
