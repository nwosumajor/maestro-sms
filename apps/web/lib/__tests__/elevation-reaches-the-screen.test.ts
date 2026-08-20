// =============================================================================
// The elevation the API honoured and the screen hid
// =============================================================================
// The session cookie carries ROLES only — a principal's ~97 permission strings
// pushed it past nginx's 4 KB header buffer — and the UI expands them through
// the same map the seed writes to the DB. Right for a role. Blind to a JIT
// elevation grant, which is by definition not derivable from one.
//
// So the two layers disagreed. Measured against the running stack, one teacher,
// one ACTIVE approved grant for hr.read:
//
//     API   /hr/employees  →  200, 14 employees
//     PAGE  /hr            →  redirected to /dashboard
//
// Elevation is the platform's designed answer to an absent colleague, and it
// reached only somebody willing to call the API by hand. Nav entries, dashboard
// tiles and page gates all read this one list, so it was every screen.
// =============================================================================

import { sessionPermissions } from "../permissions";
import { permissionsForRoles } from "@sms/types";

describe("what the UI may offer", () => {
  it("is the role permissions when nothing is on loan", () => {
    expect(sessionPermissions(["teacher"])).toEqual(permissionsForRoles(["teacher"]));
  });

  it("includes a permission held only by an elevation grant", () => {
    const perms = sessionPermissions(["teacher"], ["hr.read"]);
    expect(permissionsForRoles(["teacher"])).not.toContain("hr.read");
    expect(perms).toContain("hr.read");
  });

  it("keeps every role permission alongside it", () => {
    const role = permissionsForRoles(["teacher"]);
    const perms = sessionPermissions(["teacher"], ["hr.read"]);
    for (const p of role) expect(perms).toContain(p);
  });

  it("does not duplicate one the role already carries", () => {
    // A grant can name something the role holds. The list gates UI by
    // membership, so a duplicate is harmless — but it would grow the array on
    // every refresh of a long-lived session, and this list is read on every
    // render of every page.
    const perms = sessionPermissions(["hr_clerk"], ["hr.read"]);
    expect(perms.filter((p) => p === "hr.read")).toHaveLength(1);
  });

  it("drops the affordance when the grant lapses", () => {
    // The refresh re-reads active grants, so an expired one comes back absent.
    // This is the half that matters most: an affordance outliving the authority
    // behind it is a refusal the user was invited to walk into.
    expect(sessionPermissions(["teacher"], [])).not.toContain("hr.read");
  });

  it("gives an unknown role nothing, with or without a grant", () => {
    expect(sessionPermissions(["not_a_role"])).toEqual([]);
    expect(sessionPermissions(["not_a_role"], ["hr.read"])).toEqual(["hr.read"]);
  });
});
