// =============================================================================
// The pastoral relationships the module did not model
// =============================================================================
// Messaging scopes a staff member's reach by the relationship they actually
// have: school-wide staff reach anyone, a teacher reaches the pupils they teach
// and those pupils' guardians, finance reaches guardians and no pupils. The
// argument is Golden Rule #5 — an adult opening a channel to a child they have
// no connection to is the thing relationship scoping exists to stop.
//
// A BOARDER'S WARDEN was missing from that list. The adult responsible for a
// child overnight could not write to them or to their parents, and neither could
// write to the warden — so a boarding school's most immediate pastoral
// relationship was the one the module did not know about.
//
// The reverse direction was also narrower than anyone intended. A family could
// not message the head teacher, the school office, the librarian or their
// child's warden, several of whom could message THEM. A one-way pastoral
// relationship is the same defect this module was fixed for once already, on the
// teacher side.
//
// The boundary that does NOT move: a warden reaches their own hostel and no
// further, and transport staff are reachable by parents but never by children.
// =============================================================================

import { MessagingService } from "../../src/communication/messaging.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const BOARDER = "boarder-1";
const OTHER_HOSTELS_BOARDER = "boarder-elsewhere";

function make(roles: string[], opts: { boarders?: string[] } = {}) {
  const hostelAllocation = { findMany: jest.fn().mockResolvedValue((opts.boarders ?? [BOARDER]).map((studentId) => ({ studentId }))) };
  const tx = {
    hostelAllocation,
    class: { findMany: jest.fn().mockResolvedValue([]) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const s = Object.create(MessagingService.prototype) as MessagingService;
  Object.assign(s, {
    db: { runAsTenant: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)) },
    audit: { record: jest.fn() },
    notifications: {},
  });
  const p: Principal = { schoolId: "A", userId: "u-1", roles, permissions: [] };
  const scope = () =>
    (s as unknown as { recipientScope: (t: TenantTx, pr: Principal) => Promise<unknown> }).recipientScope(tx, p);
  return { s, tx, p, scope, hostelAllocation };
}

/** The role names a non-wide sender may write to, out of the built clause. */
function reachableRoles(scope: { OR: Array<Record<string, unknown>> }): string[] {
  const clause = scope.OR.find((c) => "roles" in c) as
    | { roles: { some: { role: { name: { in: string[] } } } } }
    | undefined;
  return clause?.roles.some.role.name.in ?? [];
}

describe("a warden", () => {
  it("can reach the boarders in their own hostel, and those boarders' parents", async () => {
    const { scope } = make(["warden"]);
    const out = (await scope()) as { OR: Array<Record<string, unknown>> };
    expect(out.OR).toContainEqual({ id: { in: [BOARDER] } });
    expect(out.OR).toContainEqual({ parentLinks: { some: { studentId: { in: [BOARDER] } } } });
  });

  it("is scoped to the hostels they actually run", async () => {
    // The whole point: a warden is not given every boarder in the school.
    const { scope, hostelAllocation } = make(["warden"]);
    await scope();
    expect(hostelAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "ACTIVE", room: { hostel: { wardenId: "u-1" } } }),
      }),
    );
  });

  it("reaches only CURRENT boarders — a pupil who has moved out is no longer theirs", async () => {
    const { scope, hostelAllocation } = make(["warden"]);
    await scope();
    expect((hostelAllocation.findMany.mock.calls[0][0] as { where: { status: string } }).where.status).toBe("ACTIVE");
  });

  it("costs ONE query, not a walk from hostels to rooms to allocations", async () => {
    const { scope, hostelAllocation, tx } = make(["warden"]);
    await scope();
    expect(hostelAllocation.findMany).toHaveBeenCalledTimes(1);
    // No separate hostel/room lookups: the filter reaches through the relation.
    expect(tx).not.toHaveProperty("hostel");
  });

  it("gets no pupil clause at all when their hostels are empty", async () => {
    const { scope } = make(["warden"], { boarders: [] });
    const out = (await scope()) as { OR: Array<Record<string, unknown>> };
    expect(out.OR.some((c) => "id" in c)).toBe(false);
  });
});

describe("a head warden", () => {
  it("reaches every hostel, which is the scope that role has everywhere else", async () => {
    const { scope, hostelAllocation } = make(["head_warden"], { boarders: [BOARDER, OTHER_HOSTELS_BOARDER] });
    await scope();
    const where = (hostelAllocation.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.status).toBe("ACTIVE");
    expect(where).not.toHaveProperty("room"); // no wardenId narrowing
  });
});

describe("who a family may write to", () => {
  it("now includes the head teacher, the office, the librarian and the warden", async () => {
    const { scope } = make(["parent"]);
    const roles = reachableRoles((await scope()) as never);
    for (const r of ["head_teacher", "head_admin", "junior_admin", "librarian", "warden", "head_warden"]) {
      expect(roles).toContain(r);
    }
  });

  it("lets a PARENT reach transport, because asking where the bus is, is a parent's question", async () => {
    const { scope } = make(["parent"]);
    expect(reachableRoles((await scope()) as never)).toContain("head_driver");
  });

  it("does NOT let a PUPIL reach transport", async () => {
    // SECURITY: the one place the two audiences differ. Adding head_driver to the
    // common set would hand every child in the school a private channel to
    // transport staff, who have no pastoral relationship to justify one.
    const { scope } = make(["student"]);
    const roles = reachableRoles((await scope()) as never);
    expect(roles).not.toContain("head_driver");
    expect(roles).not.toContain("driver");
    expect(roles).toContain("teacher"); // but the rest is unchanged
  });

  it("never includes a plain driver, for either audience", async () => {
    for (const role of ["parent", "student"]) {
      const { scope } = make([role]);
      expect(reachableRoles((await scope()) as never)).not.toContain("driver");
    }
  });

  it("still cannot reach another pupil or another parent", async () => {
    // The property that made this module sound in the first place, unchanged by
    // widening the staff set: a pupil's reach is staff, and only staff.
    const { scope } = make(["student"]);
    const out = (await scope()) as { OR: Array<Record<string, unknown>> };
    expect(out.OR).toHaveLength(1);
    expect(out.OR[0]).toHaveProperty("roles");
  });
});

describe("school-wide staff", () => {
  it("are still unrestricted, and pay for no extra queries", async () => {
    const { scope, hostelAllocation } = make(["principal"]);
    expect(await scope()).toBeNull();
    expect(hostelAllocation.findMany).not.toHaveBeenCalled();
  });
});
