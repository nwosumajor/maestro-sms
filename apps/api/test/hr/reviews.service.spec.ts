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
    // A REAL user row carries its roles, and the HR module now asks whether the
    // target is STAFF before opening a case or an appraisal about them.
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: "u1", name: "Ada", roles: [{ role: { name: "teacher" } }] }),
      findMany: jest.fn().mockResolvedValue([{ id: "u1", name: "Ada" }]),
    },
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
  // Submitting an appraisal now TELLS the appraisee — the chain's last step is
  // theirs, and nothing used to ask them for it.
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined), enqueueMany: jest.fn().mockResolvedValue(undefined) };
  return {
    tx,
    service: new HrReviewsService(db as never, audit as never, notifications as never),
    appraisalUpdate,
    entryCreate,
    notifications,
  };
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

// =============================================================================
// The HR module is for STAFF, and it never said so
// =============================================================================
// `openCase` and `createAppraisal` checked only that the target EXISTS in the
// tenant, so both could be opened against a PUPIL. Measured live: 201 for each.
//
// Not a tidy-up. A child's disciplinary record belongs in the student discipline
// module, which has a confidentiality chain built for it — the accused gets a
// 404, their guardian a 403, and the reporter is protected. The HR file has none
// of that and a different readership. And it is INVISIBLE to the pupil's NDPR
// export, whose gate derives student-keyed models: this table is keyed on
// `userId`, so a child's record here would appear in no section and in no
// exclusion — exactly what that manifest exists to prevent.
//
// FOUND BY ASSERTING IT: the export gate was extended to classify person-keyed
// models, `DisciplinaryCase` and `Appraisal` were written down as
// "(staff-only: a pupil can hold no row here)", and then nothing turned out to
// make that true. The claim was right; the code is what moved.
// =============================================================================

import { isStaffRoles } from "@sms/types";

describe("the HR module is for staff", () => {
  const withRoles = (roles: string[]) => ({
    id: "u1",
    name: "Volume Pupil 2",
    roles: roles.map((name) => ({ role: { name } })),
  });

  it("agrees with the shared predicate about who is staff", () => {
    // The same definition the calendar, announcements, forms, polls and
    // discussion groups use — not a sixth spelling.
    expect(isStaffRoles(["student"])).toBe(false);
    expect(isStaffRoles(["parent"])).toBe(false);
    expect(isStaffRoles(["teacher"])).toBe(true);
    expect(isStaffRoles(["librarian"])).toBe(true);
  });

  it("refuses a disciplinary case against a pupil, and says where it belongs", async () => {
    const { service, tx } = make();
    (tx.user.findFirst as jest.Mock).mockResolvedValue(withRoles(["student"]));
    await expect(service.openCase(p(), "u1", { title: "x" })).rejects.toThrow(
      /not a member of staff[\s\S]*student discipline area/,
    );
  });

  it("refuses an appraisal of a pupil", async () => {
    const { service, tx } = make();
    (tx.user.findFirst as jest.Mock).mockResolvedValue(withRoles(["student"]));
    await expect(service.createAppraisal(p(), "u1", { period: "2026" })).rejects.toThrow(/not a member of staff/);
  });

  it("still opens one against a member of staff", async () => {
    const { service, tx } = make();
    (tx.user.findFirst as jest.Mock).mockResolvedValue({ ...withRoles(["teacher"]), name: "Demo Teacher" });
    await expect(service.openCase(p(), "u1", { title: "x" })).resolves.toBeDefined();
  });

  it("treats a pupil who is ALSO a parent as still not staff", async () => {
    const { service, tx } = make();
    (tx.user.findFirst as jest.Mock).mockResolvedValue(withRoles(["student", "parent"]));
    await expect(service.openCase(p(), "u1", { title: "x" })).rejects.toThrow(/not a member of staff/);
  });
});
