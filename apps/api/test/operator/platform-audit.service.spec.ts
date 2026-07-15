// =============================================================================
// PlatformAuditService — cross-tenant audit trail (unit)
// =============================================================================
// Proves the super_admin audit console: excludes the platform org, resolves each
// actor's email + unique id + roles, filters by role, exports CSV, and 503s when
// the privileged client is unconfigured.

import { ServiceUnavailableException } from "@nestjs/common";
import { PlatformAuditService } from "../../src/operator/platform-audit.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const owner: Principal = { schoolId: "platform", userId: "owner", roles: ["super_admin"], permissions: ["platform.operate"] };
const now = new Date("2026-07-01T10:00:00Z");

function makeClient() {
  return {
    school: { findMany: jest.fn().mockResolvedValue([{ id: "s1", name: "Alpha" }]) },
    userRole: {
      findMany: jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) =>
        // role-filter call has where.role; actor-role resolution has where.userId.
        where.role ? Promise.resolve([{ userId: "u1" }]) : Promise.resolve([{ userId: "u1", role: { name: "school_admin" } }]),
      ),
    },
    user: {
      findMany: jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) =>
        where.email
          ? Promise.resolve([{ id: "u1" }])
          : Promise.resolve([{ id: "u1", name: "Ada", email: "ada@alpha.school", uniqueId: "SMS-ABC" }]),
      ),
    },
    auditLog: {
      findMany: jest.fn().mockResolvedValue([
        { id: "a1", createdAt: now, schoolId: "s1", actorId: "u1", action: "fee.approve", entity: "invoice", entityId: "i1", metadata: { amount: 5000 } },
      ]),
    },
  };
}

function makeService(client: ReturnType<typeof makeClient> | null) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const db = { runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn({}) };
  return { service: new PlatformAuditService(db as never, audit as never, { client } as never), audit };
}

describe("PlatformAuditService", () => {
  it("resolves each actor's email + unique id + roles + school", async () => {
    const { service } = makeService(makeClient());
    const { entries } = await service.list(owner, {});
    const e = entries[0];
    expect(e.actorEmail).toBe("ada@alpha.school");
    expect(e.actorUniqueId).toBe("SMS-ABC");
    expect(e.actorRoles).toEqual(["school_admin"]);
    expect(e.schoolName).toBe("Alpha");
    expect(e.action).toBe("fee.approve");
  });

  // audit_log is partitioned on createdAt, so its key — and any Prisma cursor — is
  // the COMPOSITE (id, createdAt). The token stays an opaque string on the wire.
  it("paginates: a full page hands back the last row's composite key as nextCursor", async () => {
    const { service } = makeService(makeClient());
    const page = await service.list(owner, { limit: 1 });
    expect(page.entries).toHaveLength(1);
    expect(page.nextCursor).toBe(`${now.toISOString()}_a1`);
  });

  it("applies the cursor (keyset pagination) to the audit query", async () => {
    const client = makeClient();
    const { service } = makeService(client);
    await service.list(owner, { cursor: `${now.toISOString()}_a1`, limit: 1 });
    expect(client.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id_createdAt: { id: "a1", createdAt: now } }, skip: 1 }),
    );
  });

  it("ignores a malformed/legacy bare-id cursor instead of erroring (restarts at page 1)", async () => {
    const client = makeClient();
    const { service } = makeService(client);
    await expect(service.list(owner, { cursor: "a1", limit: 1 })).resolves.toBeDefined();
    const args = client.auditLog.findMany.mock.calls[0][0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("filters to a role (narrows the actor set) and excludes the platform org", async () => {
    const client = makeClient();
    const { service } = makeService(client);
    await service.list(owner, { role: "school_admin" });
    expect(client.school.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { isPlatform: false } }));
    expect(client.userRole.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ role: { name: "school_admin" } }) }));
  });

  it("meta-audits the view", async () => {
    const { service, audit } = makeService(makeClient());
    await service.list(owner, {});
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "operator.audit.view" }), expect.anything());
  });

  it("exports a CSV report with a header and the actor's identity", async () => {
    const { service } = makeService(makeClient());
    const { csv, filename } = await service.exportCsv(owner, {});
    expect(filename).toMatch(/^platform-audit-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv.split("\r\n")[0]).toContain("Email");
    expect(csv).toContain("ada@alpha.school");
    expect(csv).toContain("SMS-ABC");
  });

  it("503s when the privileged client is not configured", async () => {
    const { service } = makeService(null);
    await expect(service.list(owner, {})).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
