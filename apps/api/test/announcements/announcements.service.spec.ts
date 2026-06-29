// =============================================================================
// AnnouncementsService — audience-filtered reads unit tests
// =============================================================================
// Proves: create posts an audience-tagged notice (audited); student-side readers
// (student/parent) see only ALL+STUDENTS, staff see everything; author names are
// resolved.

import { AnnouncementsService } from "../../src/announcements/announcements.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(rows: Record<string, unknown>[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const create = jest.fn((a: { data: Record<string, unknown> }) => Promise.resolve({ id: "a1", createdAt: new Date(), ...a.data }));
  const tx = {
    announcement: { findMany, create, findFirst: jest.fn(), delete: jest.fn() },
    user: { findFirst: jest.fn().mockResolvedValue({ name: "Principal" }), findMany: jest.fn().mockResolvedValue([{ id: "u1", name: "Principal" }]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new AnnouncementsService(db as never, audit as never), findMany, audit };
}

const principal = (roles: string[], perms: string[] = []): Principal => ({ schoolId: "A", userId: "u1", roles, permissions: perms });

describe("AnnouncementsService", () => {
  it("create posts an audience-tagged notice and audits it", async () => {
    const { service, audit } = makeService();
    const dto = await service.create(principal(["principal"], ["announcement.manage"]), { title: "T", body: "B", audience: "STUDENTS" });
    expect(dto).toMatchObject({ title: "T", audience: "STUDENTS", authorName: "Principal" });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "announcement.create", entity: "announcement" }),
      expect.anything(),
    );
  });

  it("a student sees only ALL + STUDENTS announcements", async () => {
    const { service, findMany } = makeService();
    await service.list(principal(["student"]));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { audience: { in: ["ALL", "STUDENTS"] } } }),
    );
  });

  it("a staff member sees ALL + STUDENTS + STAFF", async () => {
    const { service, findMany } = makeService();
    await service.list(principal(["teacher"]));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { audience: { in: ["ALL", "STUDENTS", "STAFF"] } } }),
    );
  });
});
