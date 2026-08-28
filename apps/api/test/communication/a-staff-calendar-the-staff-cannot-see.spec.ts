// =============================================================================
// A staff calendar the staff could not see
// =============================================================================
// `listEvents` hides STAFF-audience events from families, and decided who counts
// as staff with an ALLOW-LIST of six role names:
//
//   const STAFF = new Set(["school_admin","principal","accountant","hr_clerk","board","teacher"]);
//
// Nine staff roles had been added to the platform since it was written and none
// was added to it. Measured live against a STAFF-audience event:
//
//   teacher SEES it, school_admin SEES it
//   head_teacher / hr_manager / librarian / warden / driver / junior_admin
//     -> cannot see it        (student and parent correctly cannot either)
//
// A staff meeting invisible to the head teacher, who is a stage-1 approver in
// the staff-request chain.
//
// `packages/types/src/roles.ts` already says why this shape fails: "staff is
// defined by EXCLUSION ... A new staff role added in the seed is automatically
// staff — no code change." Six other services use that exclusion; the calendar
// was the one asking the question with a list.
//
// THE TEST IS DRIVEN FROM THE SEEDED ROLE MAP, not a list written here — a list
// in a test rots exactly like the one it is guarding.
// =============================================================================

import { NON_STAFF_ROLE_NAMES, ROLE_PERMISSIONS, isStaffRoles } from "@sms/types";

const ALL_ROLES = Object.keys(ROLE_PERMISSIONS);

describe("who counts as staff", () => {
  it("finds at least the roles this school actually has", () => {
    // A gate that walks nothing passes trivially.
    expect(ALL_ROLES.length).toBeGreaterThan(10);
  });

  it("treats EVERY seeded role except student and parent as staff", () => {
    const notStaff = ALL_ROLES.filter((r) => !isStaffRoles([r]));
    expect(notStaff.sort()).toEqual([...NON_STAFF_ROLE_NAMES].sort());
  });

  it("names the roles the old allow-list left out, so the regression is legible", () => {
    // The exact six the calendar knew about.
    const OLD = new Set(["school_admin", "principal", "accountant", "hr_clerk", "board", "teacher"]);
    const missed = ALL_ROLES.filter((r) => isStaffRoles([r]) && !OLD.has(r));
    // Not asserting the exact membership — that would be another hand-kept
    // list. Asserting that the old shape excluded real staff, which is the
    // property that made it a defect.
    expect(missed.length).toBeGreaterThan(0);
    for (const r of missed) expect(NON_STAFF_ROLE_NAMES).not.toContain(r);
  });

  it("a pupil who is also a guardian is still not staff", () => {
    expect(isStaffRoles(["student", "parent"])).toBe(false);
  });

  it("holding a staff role alongside a family one IS staff", () => {
    // A teacher whose own child attends the school.
    expect(isStaffRoles(["parent", "teacher"])).toBe(true);
  });

  it("no roles at all is not staff — the restrictive answer", () => {
    expect(isStaffRoles([])).toBe(false);
  });
});

// --- and the SERVICE, because a test on a helper proves nothing about its
// caller -- the seam that hid the CBT score and the report-card promotion line.

import { EventsService } from "../../src/communication/events.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeEvents() {
  const findMany = jest.fn().mockResolvedValue([]);
  const tx = { schoolEvent: { findMany } } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new EventsService(db as never, audit as never), findMany };
}

const asRole = (role: string): Principal => ({ schoolId: "A", userId: "u1", roles: [role], permissions: [] });

/** Did the query narrow to ALL-audience events (i.e. treat the caller as family)? */
const narrowedToFamily = (findMany: jest.Mock) =>
  findMany.mock.calls.at(-1)?.[0]?.where?.audience === "ALL";

describe("listEvents decides staffness by exclusion", () => {
  it("does not hide staff events from any seeded staff role", async () => {
    for (const role of ALL_ROLES.filter((r) => isStaffRoles([r]))) {
      const { service, findMany } = makeEvents();
      await service.listEvents(asRole(role));
      expect({ role, narrowed: narrowedToFamily(findMany) }).toEqual({ role, narrowed: false });
    }
  });

  it("still hides them from a pupil and a guardian", async () => {
    for (const role of NON_STAFF_ROLE_NAMES) {
      const { service, findMany } = makeEvents();
      await service.listEvents(asRole(role));
      expect({ role, narrowed: narrowedToFamily(findMany) }).toEqual({ role, narrowed: true });
    }
  });
});
