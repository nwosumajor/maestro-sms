// =============================================================================
// A search result you cannot open
// =============================================================================
// The omnibox federates students, staff, classes and invoices, and each category
// was gated on a permission that suggested an INTEREST in that thing rather than
// on the permission its destination actually requires. Three of the four were
// wrong, and all three failed for the same roles — the ones nobody pictures when
// writing the gate:
//
//   students -> /students/:id    needs student.profile.read
//               gate was `profile.read || grade.read || class.read`
//               so board, head_teacher, hr_clerk, hr_manager got pupils back.
//               Verified live: a board member searching "Volume" received six
//               pupils and the first answered 403.
//
//   staff    -> /admin/roles     needs rbac.manage
//               gate admitted hr.read, so an HR clerk — whose job this is —
//               was handed staff that bounced them to the dashboard.
//
//   classes  -> /timetable       needs timetable.read
//               gate was class.read, which head_teacher, hr_clerk and hr_manager
//               hold WITHOUT timetable.read.
//
// A result that cannot be opened is worse than no result: it tells the user the
// record exists and that they are being refused it. The file's own header claims
// this scoping exists to prevent exactly that, and the class category carries a
// comment about having been fixed for it once already — which is why the rule is
// now stated as a test rather than as prose.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_PERMISSIONS } from "@sms/types";

const SRC = readFileSync(join(__dirname, "../../src/search/search.service.ts"), "utf8");

/** What each destination the omnibox links to demands of its visitor. */
const DESTINATION_PERMISSION: Record<string, string> = {
  "/students/": "student.profile.read",
  "/admin/roles": "rbac.manage",
  "/hr/staff/": "hr.read",
  "/classes": "class.read",
  "/timetable": "timetable.read",
  "/fees/": "fee.read",
};

const roleHas = (role: string, perm: string) => (ROLE_PERMISSIONS[role] ?? []).includes(perm);
const SCHOOL_ROLES = Object.keys(ROLE_PERMISSIONS).filter((r) => !r.startsWith("super_") && r !== "manager_admin");

describe("the student category", () => {
  it("is gated on the permission /students/:id actually requires", () => {
    const block = SRC.slice(SRC.indexOf("// --- students"), SRC.indexOf("// --- staff"));
    expect(block).toMatch(/if \(this\.has\(p, "student\.profile\.read"\)\) \{/);
    // The old gate, which admitted four roles that could not open the result.
    expect(block).not.toMatch(/this\.has\(p, "grade\.read"\) \|\| this\.has\(p, "class\.read"\)/);
  });

  it.each(["board", "head_teacher", "hr_clerk", "hr_manager"])(
    "no longer offers pupils to %s, who cannot open one",
    (role) => {
      expect(roleHas(role, "student.profile.read")).toBe(false);
    },
  );

  it("still offers them to everyone who CAN open one", () => {
    for (const role of ["principal", "school_admin", "junior_admin", "teacher", "parent"]) {
      expect([role, roleHas(role, "student.profile.read")]).toEqual([role, true]);
    }
  });
});

describe("the staff category", () => {
  it("sends role-managers to roles and HR readers to the HR record", () => {
    const block = SRC.slice(SRC.indexOf("// --- staff"), SRC.indexOf("// --- classes"));
    expect(block).toMatch(/href: canManageRoles \? "\/admin\/roles" : `\/hr\/staff\/\$\{u\.id\}`/);
  });

  it("keeps the capability for HR rather than removing it", () => {
    // An HR clerk searching for a member of staff is the job, not an edge case.
    expect(roleHas("hr_clerk", "hr.read")).toBe(true);
    expect(roleHas("hr_clerk", "rbac.manage")).toBe(false);
    expect(SRC).toMatch(/const canReadHr = this\.has\(p, "hr\.read"\)/);
  });
});

describe("the class category", () => {
  it("sends a caller without timetable.read to /classes instead", () => {
    const block = SRC.slice(SRC.indexOf("// --- classes"), SRC.indexOf("// --- invoices"));
    expect(block).toMatch(/href: canOpenTimetable \? `\/timetable\?classId=\$\{c\.id\}` : "\/classes"/);
  });

  it("covers the roles that hold class.read without timetable.read", () => {
    const affected = SCHOOL_ROLES.filter((r) => roleHas(r, "class.read") && !roleHas(r, "timetable.read"));
    expect(affected.sort()).toEqual(["head_teacher", "hr_clerk", "hr_manager"]);
    // And /classes is reachable by every one of them.
    for (const r of affected) expect([r, roleHas(r, "class.read")]).toEqual([r, true]);
  });
});

describe("the rule, for whatever category is added next", () => {
  it("links only to destinations this file knows the permission for", () => {
    // If a new href appears that is not in DESTINATION_PERMISSION, nobody has
    // decided who can open it — which is how all three of these started.
    const hrefs = [...SRC.matchAll(/href: [^,\n]*?["`](\/[a-z/]+)/g)].map((m) => m[1]);
    const unknown = [...new Set(hrefs)].filter(
      (h) => !Object.keys(DESTINATION_PERMISSION).some((d) => h.startsWith(d.replace(/\/$/, ""))),
    );
    expect(unknown).toEqual([]);
  });

  it("gates the invoice category on the permission its page requires", () => {
    const block = SRC.slice(SRC.indexOf("// --- invoices"));
    expect(block).toMatch(/if \(this\.has\(p, "fee\.read"\)\) \{/);
  });
});
