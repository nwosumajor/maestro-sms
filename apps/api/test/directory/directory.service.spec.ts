// =============================================================================
// DirectorySearchService — role-scoped people search unit tests
// =============================================================================
// Proves: a non-super_admin searches their OWN school via the app tenant tx; a
// super_admin searches ALL schools via the privileged client; results map roles +
// location + school name; every search is audited.

import { DirectorySearchService } from "../../src/directory/directory.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const userRow = {
  id: "u1",
  uniqueId: "SMS-ABC123",
  name: "Ada",
  email: "ada@t",
  status: "ACTIVE",
  schoolId: "A",
  school: { name: "St. Mary" },
  roles: [{ role: { name: "student" } }],
  studentProfile: { city: "Lagos", state: "Lagos", country: "NG" },
};

function makeService(opts: { tenantRows?: unknown[]; privilegedRows?: unknown[] }) {
  const tenantFindMany = jest.fn().mockResolvedValue(opts.tenantRows ?? []);
  const privilegedFindMany = jest.fn().mockResolvedValue(opts.privilegedRows ?? []);
  const tx = { user: { findMany: tenantFindMany } } as unknown as TenantTx;
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new DirectorySearchService(db as never, audit as never);
  // Inject a fake privileged client (normally built in onModuleInit from a URL).
  (service as unknown as { _client: unknown })._client = { user: { findMany: privilegedFindMany } };
  return { service, audit, tenantFindMany, privilegedFindMany };
}

const principal = (perms: string[]): Principal => ({ schoolId: "A", userId: "x", roles: [], permissions: perms });

describe("DirectorySearchService", () => {
  it("school_admin searches OWN school via the tenant tx (not the privileged client)", async () => {
    const { service, tenantFindMany, privilegedFindMany, audit } = makeService({ tenantRows: [userRow] });
    const res = await service.search(principal(["directory.search"]), { q: "ada" });
    expect(tenantFindMany).toHaveBeenCalled();
    expect(privilegedFindMany).not.toHaveBeenCalled();
    expect(res[0]).toMatchObject({ uniqueId: "SMS-ABC123", roles: ["student"], schoolName: "St. Mary", location: "Lagos, Lagos, NG" });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "directory.search" }),
      expect.anything(),
    );
  });

  it("super_admin searches ALL schools via the privileged client", async () => {
    const { service, tenantFindMany, privilegedFindMany } = makeService({ privilegedRows: [userRow] });
    const res = await service.search(principal(["directory.search", "platform.operate"]), { school: "mary" });
    expect(privilegedFindMany).toHaveBeenCalled();
    // The tenant tx is only used for the audit write, not the cross-school query.
    expect(res).toHaveLength(1);
    expect(tenantFindMany).not.toHaveBeenCalled();
  });

  it("super_admin search is disabled (503) when the privileged client is unconfigured", async () => {
    const { service } = makeService({});
    (service as unknown as { _client: unknown })._client = null;
    await expect(service.search(principal(["directory.search", "platform.operate"]), {})).rejects.toThrow(/not configured/i);
  });
});
