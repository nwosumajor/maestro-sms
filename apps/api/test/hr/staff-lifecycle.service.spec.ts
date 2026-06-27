// =============================================================================
// StaffLifecycleService — checklist seeding, completion, expiry reminders
// =============================================================================

import { StaffLifecycleService } from "../../src/hr/staff-lifecycle.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function make(over: {
  item?: Record<string, unknown> | null;
  items?: Array<Record<string, unknown>>;
  docs?: Array<Record<string, unknown>>;
} = {}) {
  const itemCreate = jest.fn().mockResolvedValue({});
  const checklistUpdate = jest.fn((a: { data: { status: string } }) =>
    Promise.resolve({ id: "c1", userId: "u1", type: "ONBOARDING", status: a.data.status, createdAt: new Date() }),
  );
  const itemUpdate = jest.fn().mockResolvedValue({});
  const docUpdate = jest.fn().mockResolvedValue({});
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const tx = {
    user: { findFirst: jest.fn().mockResolvedValue({ id: "u1", name: "Ada" }), findMany: jest.fn().mockResolvedValue([{ id: "u1", name: "Ada" }]) },
    staffChecklist: {
      create: jest.fn().mockResolvedValue({ id: "c1", userId: "u1", type: "ONBOARDING", status: "OPEN", createdAt: new Date() }),
      findMany: jest.fn().mockResolvedValue([]),
      update: checklistUpdate,
    },
    staffChecklistItem: {
      create: itemCreate,
      findMany: jest.fn().mockResolvedValue(over.items ?? []),
      findFirst: jest.fn().mockResolvedValue(over.item ?? null),
      update: itemUpdate,
    },
    staffDocument: {
      create: jest.fn().mockResolvedValue({ id: "d1", userId: "u1", kind: "CONTRACT", name: "x", documentId: null, expiresAt: null, reminderSentAt: null, createdAt: new Date() }),
      findMany: jest.fn().mockResolvedValue(over.docs ?? []),
      update: docUpdate,
    },
    trainingRecord: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    role: { findMany: jest.fn().mockResolvedValue([{ id: "r1" }]) },
    userRole: { findMany: jest.fn().mockResolvedValue([{ userId: "hr1" }]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { enqueue };
  return { service: new StaffLifecycleService(db as never, audit as never, notifications as never), itemCreate, checklistUpdate, docUpdate, enqueue };
}

const p = (userId = "hr1"): Principal => ({ schoolId: "A", userId, roles: [], permissions: [] });

describe("StaffLifecycleService", () => {
  it("createChecklist seeds the default ONBOARDING tasks", async () => {
    const { service, itemCreate } = make({ items: [{ id: "i1", label: "Sign", sequence: 0, done: false, doneAt: null }] });
    await service.createChecklist(p(), "u1", "ONBOARDING");
    expect(itemCreate).toHaveBeenCalledTimes(5); // 5 default onboarding tasks
  });

  it("toggleItem marks the checklist COMPLETED once every task is done", async () => {
    const { service, checklistUpdate } = make({
      item: { id: "i1", checklistId: "c1", done: false },
      items: [{ id: "i1", label: "Sign", sequence: 0, done: true, doneAt: new Date() }],
    });
    await service.toggleItem(p(), "i1", true);
    expect(checklistUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "COMPLETED" } }));
  });

  it("runDocumentReminders notifies HR for an expiring doc and stamps reminderSentAt", async () => {
    const { service, docUpdate, enqueue } = make({
      docs: [{ id: "d1", userId: "u1", kind: "CONTRACT", name: "Contract", expiresAt: new Date(Date.now() + 5 * 86_400_000) }],
    });
    const res = await service.runDocumentReminders(p());
    expect(res.reminded).toBe(1);
    expect(docUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reminderSentAt: expect.any(Date) }) }));
    expect(enqueue).toHaveBeenCalledTimes(1); // one HR recipient
  });

  it("runDocumentReminders is a no-op when nothing is due", async () => {
    const { service, enqueue } = make({ docs: [] });
    await expect(service.runDocumentReminders(p())).resolves.toEqual({ reminded: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
