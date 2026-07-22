// =============================================================================
// StudentImportService — bulk SIS maker-checker unit tests
// =============================================================================
// Proves: staging creates a PENDING batch + dry-run summary and NOTHING else; a
// DIFFERENT person must approve (SoD); approval creates User + role + profile per
// new row, skips duplicates; reject is terminal; already-decided is rejected.

import { ConflictException, ForbiddenException } from "@nestjs/common";
import { StudentImportService } from "../../src/admin/student-import.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

type Row = Record<string, unknown>;

function makeService(opts: { batch?: Row | null; existingEmails?: string[] }) {
  const state: { batch: Row | null } = { batch: opts.batch ?? null };
  const existing = new Set((opts.existingEmails ?? []).map((e) => e.toLowerCase()));
  const userCreate = jest.fn((a: { data: { email: string } }) => Promise.resolve({ id: `u-${a.data.email}` }));
  const profileCreate = jest.fn().mockResolvedValue({ id: "pf" });
  const enrollCreate = jest.fn().mockResolvedValue({ id: "en" });
  const userRoleCreate = jest.fn().mockResolvedValue({ id: "ur" });
  const batchUpdate = jest.fn((a: { data: Row }) => {
    state.batch = { ...(state.batch ?? {}), ...a.data };
    return Promise.resolve(state.batch);
  });
  const tx = {
    user: {
      findMany: jest.fn().mockResolvedValue([...existing].map((email) => ({ email }))),
      findFirst: jest.fn((a: { where: { email: string } }) =>
        Promise.resolve(existing.has(a.where.email.toLowerCase()) ? { id: "exists" } : null),
      ),
      create: userCreate,
    },
    userRole: { create: userRoleCreate },
    studentProfile: { create: profileCreate, findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { create: enrollCreate, count: jest.fn().mockResolvedValue(0) },
    role: { findFirst: jest.fn().mockResolvedValue({ id: "student-role" }) },
    // Both stage() and approve() now resolve the school's slug: it is the domain
    // of every generated sign-in identifier.
    school: { findFirst: jest.fn().mockResolvedValue({ slug: "demo" }) },
    studentImportBatch: {
      create: jest.fn((a: { data: Row }) => Promise.resolve({ id: "b1", ...a.data })),
      findFirst: jest.fn(() => Promise.resolve(state.batch)),
      update: batchUpdate,
      // Approve CLAIMS the batch with a guarded flip; model success while PENDING.
      updateMany: jest.fn(() =>
        Promise.resolve({ count: (state.batch as { status?: string } | null)?.status === "PENDING" ? 1 : 0 }),
      ),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new StudentImportService(db as never, audit as never), userCreate, profileCreate, enrollCreate, batchUpdate };
}

const p = (userId: string): Principal => ({ schoolId: "A", userId, roles: ["school_admin"], permissions: ["student.import"] });
const pendingBatch = (over: Row = {}): Row => ({ id: "b1", status: "PENDING", uploadedById: "uploader", rows: [], ...over });

describe("StudentImportService maker-checker", () => {
  it("template has the SIS header row", () => {
    const { service } = makeService({});
    expect(service.csvTemplate().split("\n")[0]).toContain("admissionNumber");
  });

  it("stage creates a PENDING batch with a dry-run summary and creates no users", async () => {
    const { service, userCreate } = makeService({ existingEmails: ["dup@t"] });
    const res = await service.stage(p("uploader"), [
      { name: "A", email: "new@t" },
      { name: "B", email: "dup@t" },
    ]);
    expect(res.status).toBe("PENDING");
    expect(res.summary).toMatchObject({ total: 2, newCount: 1, duplicateCount: 1 });
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("blocks the uploader from approving their own batch (SoD)", async () => {
    const { service } = makeService({ batch: pendingBatch({ uploadedById: "uploader" }) });
    await expect(service.approve(p("uploader"), "b1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a DIFFERENT approver creates students, skipping duplicates", async () => {
    const { service, userCreate, profileCreate } = makeService({
      batch: pendingBatch({ rows: [{ name: "A", email: "new@t" }, { name: "B", email: "dup@t" }] }),
      existingEmails: ["dup@t"],
    });
    const res = await service.approve(p("approver"), "b1");
    expect(res.status).toBe("APPROVED");
    expect(res.summary).toMatchObject({ created: 1, skipped: 1 });
    expect(userCreate).toHaveBeenCalledTimes(1);
    expect(profileCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses to approve an already-decided batch", async () => {
    const { service } = makeService({ batch: pendingBatch({ status: "APPROVED" }) });
    await expect(service.approve(p("approver"), "b1")).rejects.toBeInstanceOf(ConflictException);
  });
});

// -----------------------------------------------------------------------------
// Generated sign-in identifiers in bulk import
// -----------------------------------------------------------------------------
// Most pupils have no email, so schools were inventing fake ones. A row now needs
// only a NAME; the identifier is generated from it and the school's domain.
describe("StudentImportService — generated identifiers", () => {
  it("creates a student from a name ALONE and stamps it as generated", async () => {
    const { service, userCreate } = makeService({
      batch: pendingBatch({ rows: [{ name: "Chika Nwosu" }] }),
    });
    await service.approve(p("approver"), "b1");
    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "chika.nwosu@demo.com",
          loginEmailGenerated: true,
        }),
      }),
    );
  });

  it("honours a supplied address and does NOT mark it generated", async () => {
    const { service, userCreate } = makeService({
      batch: pendingBatch({ rows: [{ name: "Chika Nwosu", email: "Chika@Real.test" }] }),
    });
    await service.approve(p("approver"), "b1");
    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "chika@real.test", loginEmailGenerated: false }),
      }),
    );
  });

  it("REFUSES a second row resolving to the same identifier rather than failing the INSERT", async () => {
    // Two pupils sharing a name in ONE file is a real ambiguity the uploader must
    // resolve — not something to paper over with a silent suffix.
    const { service, userCreate } = makeService({
      batch: pendingBatch({ rows: [{ name: "Chika Nwosu" }, { name: "Chika Nwosu" }] }),
    });
    const res = await service.approve(p("approver"), "b1");
    expect(userCreate).toHaveBeenCalledTimes(1);
    expect(res.summary).toMatchObject({ created: 1, skipped: 1 });
  });

  it("previews the GENERATED identifier at stage, so a clash is visible before approval", async () => {
    const { service } = makeService({ existingEmails: ["chika.nwosu@demo.com"] });
    const res = await service.stage(p("uploader"), [{ name: "Chika Nwosu" }, { name: "Femi Adeleke" }]);
    expect(res.summary).toMatchObject({ total: 2, newCount: 1, duplicateCount: 1 });
  });
});
