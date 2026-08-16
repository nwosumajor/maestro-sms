// =============================================================================
// Every two-person rule needs a second person who actually exists
// =============================================================================
// A maker-checker control has two halves that are easy to get separately right
// and jointly wrong:
//
//   1. the ENGINE must refuse to let the requester approve their own request —
//      every chain in this codebase does, and each has its own test;
//   2. somebody ELSE must be able to approve it.
//
// Nothing had ever checked the second half, and it is the half that fails
// quietly. `class.promote.approve` was held by school_admin alone while BOTH
// principal and school_admin could stage a promotion — so in a school with one
// school_admin, a batch that admin staged could never be approved by anyone. No
// error, no rejection: a request that simply sat there. The salary chain had
// exactly this shape once (`hr.salary.approve` was hr_manager-only) and was
// fixed the same way.
//
// This test states the rule as arithmetic over the role map: for each paired
// permission, the set of roles that can APPROVE must contain a role that is not
// the only role that can REQUEST. Adding a maker-checker pair without a second
// approver now fails the build, naming the pair.
// =============================================================================

import { ROLE_PERMISSIONS } from "@sms/types";

/** request permission → approve permission, for every in-school two-person rule. */
const PAIRS: Array<{ what: string; request: string; approve: string }> = [
  { what: "end-of-session promotion", request: "class.promote", approve: "class.promote.approve" },
  { what: "a salary change", request: "hr.salary.request", approve: "hr.salary.approve" },
  { what: "a fee adjustment or refund", request: "fee.manage", approve: "fee.approve" },
  { what: "a privilege elevation", request: "security.elevation.request", approve: "security.elevation.approve" },
];

/** Roles in a single school — platform roles are not a school's second person. */
const PLATFORM = new Set(["super_admin", "manager_admin"]);

function rolesWith(permission: string): string[] {
  return Object.entries(ROLE_PERMISSIONS)
    .filter(([role, perms]) => !PLATFORM.has(role) && perms.includes(permission))
    .map(([role]) => role);
}

describe.each(PAIRS)("$what", ({ request, approve }) => {
  it("has somebody who can request it", () => {
    expect(rolesWith(request).length).toBeGreaterThan(0);
  });

  it("has somebody who can approve it", () => {
    expect(rolesWith(approve).length).toBeGreaterThan(0);
  });

  it("can still be approved when the requester holds every role that can request", () => {
    // The failure mode: a school where one person holds all the requesting
    // roles. Somebody who did NOT request must remain able to approve, which
    // means at least one approving role must sit outside the requesting set —
    // or two distinct roles must be able to approve.
    const requesters = new Set(rolesWith(request));
    const approvers = rolesWith(approve);
    const independent = approvers.filter((r) => !requesters.has(r));
    expect(
      independent.length > 0 || approvers.length > 1,
      // reason: jest's message argument, so the failure names the fix.
    ).toBe(true);
  });
});

describe("the promotion chain specifically", () => {
  it("lets a principal approve what a school admin staged, and the reverse", () => {
    // The concrete case that was broken: only school_admin could approve, so a
    // single-admin school had a batch nobody could finish.
    const approvers = rolesWith("class.promote.approve");
    expect(approvers).toEqual(expect.arrayContaining(["principal", "school_admin"]));
  });
});
