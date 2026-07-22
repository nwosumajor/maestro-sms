// =============================================================================
// Platform-tier roles are the OWNER's alone — school admins can't see or touch
// =============================================================================
// Regression guard for a real privilege-escalation hole: the non-assignable
// list was hand-maintained and named only `super_admin`, so when
// `manager_admin` was later added as a platform role nobody updated it. A
// principal/school_admin with rbac.manage could therefore grant manager_admin
// — handing a school-level user SEVEN cross-tenant `platform.*` permissions.
//
// The fix derives the restriction from the permission map, so these tests also
// assert the DERIVATION, not just the two role names we know about today.
// =============================================================================

import { PLATFORM_TIER_ROLES, ROLE_PERMISSIONS, isPlatformTierRole } from "@sms/types";
import { AdminService } from "../../src/admin/admin.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const schoolAdmin = (): Principal => ({
  userId: "admin-1",
  schoolId: "school-1",
  roles: ["school_admin"],
  permissions: ["rbac.manage"],
});
const owner = (): Principal => ({
  userId: "owner-1",
  schoolId: "platform-1",
  roles: ["super_admin"],
  permissions: ["rbac.manage"],
});

/** AdminService with just enough DB to exercise the guards. */
function makeService(roleRows: { name: string }[]) {
  const db = {
    runAsTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn({
        role: { findMany: async () => roleRows, findFirst: async () => ({ id: "r1" }) },
        user: { findFirst: async () => ({ id: "u1", name: "Target" }) },
        userRole: { findMany: async () => [], deleteMany: async () => ({ count: 1 }) },
      }),
  };
  const audit = { record: async () => undefined };
  return new AdminService(db as never, audit as never, {} as never, { client: null } as never, {
    onFinalized: () => undefined,
  } as never);
}

describe("platform-tier roles", () => {
  it("DERIVES the platform tier from the permission map (not a hand-list)", () => {
    // Anything carrying a platform.* permission must be classified platform-tier.
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      const hasPlatformPerm = perms.some((p) => p.startsWith("platform."));
      expect(isPlatformTierRole(role)).toBe(hasPlatformPerm);
    }
    // The two we know about today — manager_admin is the one that was missed.
    expect(PLATFORM_TIER_ROLES).toEqual(expect.arrayContaining(["super_admin", "manager_admin"]));
    // A school role must never be classified platform-tier.
    for (const r of ["principal", "school_admin", "teacher", "junior_admin", "parent"]) {
      expect(isPlatformTierRole(r)).toBe(false);
    }
  });

  it("HIDES platform roles from a school admin's role list, but not the owner's", async () => {
    const rows = [{ name: "teacher" }, { name: "manager_admin" }, { name: "super_admin" }, { name: "principal" }];
    const svc = makeService(rows);

    const asSchool = (await svc.listRoles(schoolAdmin())) as { name: string }[];
    expect(asSchool.map((r) => r.name)).toEqual(["teacher", "principal"]);

    const asOwner = (await svc.listRoles(owner())) as { name: string }[];
    expect(asOwner.map((r) => r.name)).toEqual(rows.map((r) => r.name)); // owner sees everything
  });

  it("REFUSES to create a user with a platform role — and 404s so the role's existence isn't leaked", async () => {
    const svc = makeService([{ name: "manager_admin" }]);
    await expect(
      svc.createUser(schoolAdmin(), { name: "Mallory", email: "m@x.test", role: "manager_admin" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("REFUSES to assign a platform role to an existing user", async () => {
    const svc = makeService([{ name: "manager_admin" }]);
    await expect(svc.assignRole(schoolAdmin(), "victim-1", "manager_admin")).rejects.toMatchObject({ status: 404 });
    await expect(svc.assignRole(schoolAdmin(), "victim-1", "super_admin")).rejects.toMatchObject({ status: 404 });
  });

  it("REFUSES to remove a platform role either — a school admin cannot modify the tier at all", async () => {
    const svc = makeService([{ name: "manager_admin" }]);
    await expect(svc.removeRole(schoolAdmin(), "someone", "manager_admin")).rejects.toMatchObject({ status: 404 });
  });
});
