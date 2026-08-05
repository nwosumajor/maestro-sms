// =============================================================================
// GET /users?kind= — the picker filters
// =============================================================================
// These assert the QUERY, not the returned rows. The behaviour under test IS a
// filter, and a mock that hands back the same list whatever the `where` says
// keeps passing after the filter is deleted — which is exactly how a co-host
// picker came to offer colleagues the endpoint would refuse.
// =============================================================================

import { MEETING_PERMISSIONS, NON_STAFF_ROLE_NAMES, type UserKind } from "@sms/types";
import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantTx } from "../../src/integrity/integrity.foundation";

const principal = { userId: "u1", schoolId: "s1", roles: ["principal"], permissions: [] } as unknown as Principal;

function harness() {
  const seen: Array<Record<string, unknown>> = [];
  const tx = {
    user: {
      findMany: jest.fn((args: { where?: Record<string, unknown> }) => {
        seen.push(args?.where ?? {});
        return Promise.resolve([]);
      }),
    },
    role: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  return { svc: new LmsService(db as never, { record: jest.fn() } as never), seen };
}

const roleWhere = (w: Record<string, unknown>) =>
  ((w.roles as { some?: { role?: Record<string, unknown> } })?.some?.role ?? {}) as Record<string, unknown>;

describe("user picker filters", () => {
  it("kind=meeting-host asks for staff who hold meeting.host", async () => {
    const { svc, seen } = harness();
    await svc.listUsers(principal, "meeting-host" as UserKind);
    const role = roleWhere(seen[0]);
    expect(role.permissions).toEqual({ some: { permission: { key: MEETING_PERMISSIONS.MEETING_HOST } } });
    // Still staff-only: the permission alone must not readmit a parent.
    expect(role.name).toEqual({ notIn: [...NON_STAFF_ROLE_NAMES] });
  });

  it("kind=staff does NOT filter on a permission", async () => {
    // The distinction is the whole point of the new kind — if plain staff also
    // carried the permission filter, the two would be the same query and the
    // co-host picker would prove nothing.
    const { svc, seen } = harness();
    await svc.listUsers(principal, "staff");
    expect(roleWhere(seen[0]).permissions).toBeUndefined();
  });

  it("kind=parent asks only for parents", async () => {
    const { svc, seen } = harness();
    await svc.listUsers(principal, "parent");
    expect(roleWhere(seen[0]).name).toBe("parent");
  });
});
