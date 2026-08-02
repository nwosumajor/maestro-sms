// =============================================================================
// Discipline — telling the family, and keeping the previous decision
// =============================================================================
// The module recorded permanent disciplinary outcomes against children and
// notified NOBODY — not the student, not their guardians. A sanction could be
// entered, and later quietly revised, with the family never told and the earlier
// outcome simply gone, because `resolution` is a mutable column.
//
// Two properties are pinned here, and the reasoning matters as much as the code:
//
//   • NOTIFIED ON THE DECISION, NOT ON FILING. A complaint is an allegation
//     nobody has reviewed. Alerting a parent the moment anyone files one would
//     pre-judge it, and would hand a malicious filer a way to upset a family at
//     will. The outcome is the thing that lands on the record.
//   • THE PREVIOUS DECISION SURVIVES. Revising a decided complaint writes an
//     append-only entry naming what it was and who changed it, so the history is
//     tamper-evident even though the current value is editable.
// =============================================================================

import { DisciplineService } from "../../src/discipline/discipline.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const SCHOOL = "s-1";
const staff: Principal = {
  schoolId: SCHOOL,
  userId: "u-staff",
  roles: ["school_admin"],
  permissions: ["discipline.manage", "discipline.file"],
};

function makeService(before: Record<string, unknown>) {
  const entries: Array<Record<string, unknown>> = [];
  const tx = {
    disciplineComplaint: {
      findFirst: jest.fn().mockResolvedValue(before),
      update: jest.fn().mockResolvedValue({}),
    },
    disciplineEntry: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        entries.push(data);
        return data;
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    parentChild: { findMany: jest.fn().mockResolvedValue([{ parentId: "p-1" }, { parentId: "p-2" }]) },
    disciplineAssignee: { findMany: jest.fn().mockResolvedValue([]) },
    disciplineEvidence: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "st-1", name: "A Student" }), findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn() },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const storage = {};
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined), enqueueMany: jest.fn().mockResolvedValue(undefined) };
  const svc = new DisciplineService(db as never, audit as never, storage as never, notifications as never);
  // complaintDto reads back through the tx; stub it so these tests stay about
  // the OUTCOME behaviour rather than about DTO assembly.
  (svc as unknown as { complaintDto: unknown }).complaintDto = jest.fn().mockResolvedValue({ id: "c-1" });
  return { svc, tx, notifications, entries, audit };
}

const OPEN_AGAINST_STUDENT = {
  status: "OPEN",
  resolution: null,
  againstId: "st-1",
  againstType: "STUDENT",
  subject: "Late to assembly repeatedly",
};

describe("concluding a complaint tells the family", () => {
  it("notifies the student AND both guardians", async () => {
    const { svc, notifications } = makeService(OPEN_AGAINST_STUDENT);
    await svc.resolve(staff, "c-1", { status: "RESOLVED", resolution: "Verbal warning" });
    const [, recipients, payload] = (notifications.enqueueMany as jest.Mock).mock.calls[0];
    expect(recipients.sort()).toEqual(["p-1", "p-2", "st-1"]);
    expect(payload.type).toBe("DISCIPLINE_OUTCOME");
  });

  it("notifies on a DISMISSAL too — being cleared is also an outcome", async () => {
    const { svc, notifications } = makeService(OPEN_AGAINST_STUDENT);
    await svc.resolve(staff, "c-1", { status: "DISMISSED" });
    expect(notifications.enqueueMany).toHaveBeenCalled();
  });

  it("does NOT notify while the matter is merely under review", async () => {
    // IN_REVIEW is not a decision. Telling a family a complaint exists, before
    // anyone has judged it, pre-judges it.
    const { svc, notifications } = makeService(OPEN_AGAINST_STUDENT);
    await svc.resolve(staff, "c-1", { status: "IN_REVIEW" });
    expect(notifications.enqueueMany).not.toHaveBeenCalled();
  });

  it("keeps the detail OUT of the message", async () => {
    // The notification says a matter concluded and to contact the office. The
    // substance of a disciplinary finding about a child should not sit in an
    // email inbox or an SMS, which is why the body carries no resolution text.
    const { svc, notifications } = makeService(OPEN_AGAINST_STUDENT);
    await svc.resolve(staff, "c-1", { status: "RESOLVED", resolution: "Excluded for two days" });
    const payload = (notifications.enqueueMany as jest.Mock).mock.calls[0][2];
    expect(JSON.stringify(payload)).not.toContain("Excluded for two days");
    expect(payload.body).toMatch(/contact the school office/i);
  });

  it("tells a TEACHER only themselves — not a student's guardians", async () => {
    const { svc, notifications, tx } = makeService({
      ...OPEN_AGAINST_STUDENT,
      againstId: "t-1",
      againstType: "TEACHER",
    });
    await svc.resolve(staff, "c-1", { status: "RESOLVED", resolution: "Note on file" });
    expect((notifications.enqueueMany as jest.Mock).mock.calls[0][1]).toEqual(["t-1"]);
    // A colleague's disciplinary matter must not go looking for anyone's parents.
    expect(tx.parentChild.findMany).not.toHaveBeenCalled();
  });

  it("still records the decision when notifying fails", async () => {
    // A delivery failure must never undo a recorded outcome.
    const { svc, tx, notifications } = makeService(OPEN_AGAINST_STUDENT);
    (notifications.enqueueMany as jest.Mock).mockRejectedValue(new Error("queue down"));
    await expect(svc.resolve(staff, "c-1", { status: "RESOLVED" })).resolves.toBeDefined();
    expect(tx.disciplineComplaint.update).toHaveBeenCalled();
  });
});

describe("revising a decided complaint keeps the previous decision", () => {
  const DECIDED = { ...OPEN_AGAINST_STUDENT, status: "RESOLVED", resolution: "Verbal warning" };

  it("writes an append-only entry naming the old outcome and the change", async () => {
    const { svc, entries } = makeService(DECIDED);
    await svc.resolve(staff, "c-1", { status: "DISMISSED", resolution: "Withdrawn after review" });
    expect(entries).toHaveLength(1);
    expect(String(entries[0].body)).toContain("RESOLVED → DISMISSED");
    expect(String(entries[0].body)).toContain("Verbal warning");
    expect(entries[0].authorId).toBe(staff.userId);
  });

  it("writes one when only the WORDING changes, status untouched", async () => {
    // The words are the sanction. Rewriting them silently is the whole risk.
    const { svc, entries } = makeService(DECIDED);
    await svc.resolve(staff, "c-1", { status: "RESOLVED", resolution: "Two-day exclusion" });
    expect(entries).toHaveLength(1);
    expect(String(entries[0].body)).toContain("Verbal warning");
  });

  it("writes NOTHING extra on the FIRST decision", async () => {
    // There is no previous outcome to preserve, and a spurious entry on every
    // conclusion would bury the real revisions.
    const { svc, entries } = makeService(OPEN_AGAINST_STUDENT);
    await svc.resolve(staff, "c-1", { status: "RESOLVED", resolution: "Verbal warning" });
    expect(entries).toHaveLength(0);
  });

  it("writes nothing when the call changes neither status nor wording", async () => {
    const { svc, entries } = makeService(DECIDED);
    await svc.resolve(staff, "c-1", { status: "RESOLVED", resolution: "Verbal warning" });
    expect(entries).toHaveLength(0);
  });

  it("audits the revision as a revision", async () => {
    const { svc, audit } = makeService(DECIDED);
    await svc.resolve(staff, "c-1", { status: "DISMISSED" });
    // The audit metadata must distinguish a first decision from a rewrite, or the
    // trail cannot answer "was this outcome ever changed?".
    const entry = (audit.record as jest.Mock).mock.calls.at(-1)![0];
    expect(entry.action).toBe("discipline.resolve");
    expect(entry.metadata).toMatchObject({ revisedDecision: true, previousStatus: "RESOLVED" });
  });
});
