/**
 * The access review counted elevations the API would already refuse.
 *
 * A privilege grant auto-expires by TIME. `status` only leaves ACTIVE when
 * somebody explicitly revokes it, there is no EXPIRED status, and nothing sweeps
 * elapsed rows — so an elevation that ran out weeks ago still reads
 * `status: "ACTIVE"` for ever.
 *
 * `recertification` filtered on status ALONE and returned the result as
 * `activeElevations`, which `/admin/recertification` renders as a headline count
 * labelled "Active elevations" and describes as "live elevations". So the one
 * artifact a school reviews to answer "who can do what" named powers the guard
 * had already stopped honouring.
 *
 * The guard was always right: `activeGrantPermissions` — "the ONE definition of
 * what a grant gives you", called by the guard AND by login/refresh — requires
 * `status: "ACTIVE"` AND `expiresAt: { gt: now }`. The report now asks the same
 * two questions.
 *
 * Over-reporting is the SAFE direction and still wrong: a review list that is
 * mostly dead entries is one people stop reading, and a genuinely live grant
 * hides among them.
 */
import { readFileSync } from "fs";
import { stripComments } from "../support/strip-comments";
import { join } from "path";
import { SecurityService } from "../../src/security/security.service";
import type { Principal, TenantTx } from "../../src/integrity/integrity.foundation";

const SRC = join(__dirname, "../../src");
const code = (p: string) =>
  stripComments(readFileSync(join(SRC, p), "utf8"));

const P: Principal = { schoolId: "S", userId: "admin-1", roles: ["school_admin"], permissions: [] };

function makeService() {
  const grantFindMany = jest.fn().mockResolvedValue([]);
  const tx = {
    role: { findMany: jest.fn().mockResolvedValue([]) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
    privilegeGrant: { findMany: grantFindMany },
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const svc = Object.create(SecurityService.prototype) as SecurityService;
  Object.assign(svc as unknown as Record<string, unknown>, {
    db: { runAsTenant: (_c: unknown, fn: (t: TenantTx) => unknown) => fn(tx) },
    ctx: () => ({ schoolId: "S", userId: "admin-1" }),
  });
  return { svc, grantFindMany };
}

describe("an elevation that had already lapsed", () => {
  it("asks for grants that are ACTIVE and not yet elapsed", async () => {
    const { svc, grantFindMany } = makeService();
    await (svc as unknown as { recertification: (p: Principal) => Promise<unknown> }).recertification(P);
    const where = grantFindMany.mock.calls[0][0].where;
    expect(where.status).toBe("ACTIVE");
    expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
  });

  it("uses the same two conditions the guard does", () => {
    // Not "looks similar": both must require status AND an expiry in the future,
    // because the report existing to describe the guard is the whole point.
    const guard = code("auth/active-grants.ts");
    const report = code("security/security.service.ts");
    for (const src of [guard, report]) {
      expect(src).toMatch(/status: "ACTIVE"/);
      expect(src).toMatch(/expiresAt: \{ gt: new Date\(\) \}/);
    }
  });

  it("there is still no EXPIRED status doing this job instead", () => {
    // If a sweep is ever added that flips elapsed rows, this filter becomes
    // belt-and-braces rather than the only thing standing between the report and
    // a list of ghosts — and whoever adds it should see this.
    const src = code("security/security.service.ts") + code("auth/active-grants.ts");
    expect(src).not.toMatch(/"EXPIRED"/);
  });
});
