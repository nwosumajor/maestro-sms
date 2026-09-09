// =============================================================================
// A manual trigger must match the permission that gates it
// =============================================================================
// Third instance of a class already in the log. The exeat sweep was gated on
// per-school `hostel.manage` and ran the FLEET; the same shape was then found
// in three more places:
//
//   privacy.archive              `privacy.archive.manage`  principal, school_admin
//   privacy.breachDeadline       `privacy.compliance.manage` principal, school_admin
//   notifications.deliveryRecovery `notification.send`     ...and every TEACHER
//
// Measured live on a 5,000-school fleet: one demo school's principal pressed
// "Run now" on the archive sweep and created 500 permanent archives in 500
// OTHER schools — 3,500 -> 4,000 — each a full snapshot of another
// institution's term, written to storage and to their registry.
//
// This gate is the durable half. It reads the catalogue and the role map and
// fails on a manual trigger DECLARED platform-wide whose permission a
// school-scoped role holds. A declared scope is a claim, and a claim typed
// beside code rots — this one had already gone stale on two entries by the time
// it was checked.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_PERMISSIONS } from "@sms/types";
import { SCHEDULED_JOBS } from "../../src/maintenance/job-runs.service";

const PLATFORM_ROLES = new Set(["super_admin", "manager_admin"]);

type Manual = { key: string; permission: string; scope: string };

/**
 * The catalogue as DATA. Reading it with a regex made this gate a fact about
 * the regex: a comment added between `permission` and `scope` put two entries
 * out of its window, and it went green having scanned fewer jobs than it had
 * the run before.
 */
function catalogueManuals(): Manual[] {
  return SCHEDULED_JOBS.flatMap((j) =>
    "manual" in j && j.manual ? [{ key: j.key as string, permission: j.manual.permission, scope: j.manual.scope }] : [],
  );
}

/** Roles that are NOT platform staff and hold this permission as standing role. */
function schoolRolesHolding(permission: string): string[] {
  return Object.entries(ROLE_PERMISSIONS)
    .filter(([role, perms]) => !PLATFORM_ROLES.has(role) && (perms as readonly string[]).includes(permission))
    .map(([role]) => role);
}

describe("the job catalogue's manual triggers", () => {
  const manuals = catalogueManuals();

  // A walk that finds nothing produces no offenders and passes green.
  it("scanned the catalogue at all", () => {
    expect(manuals.length).toBeGreaterThanOrEqual(10);
    expect(manuals.map((m) => m.key)).toContain("privacy.archive");
  });

  it("declares no PLATFORM trigger a school role can fire", () => {
    const wrong = manuals
      .filter((m) => m.scope === "PLATFORM")
      .map((m) => ({ ...m, roles: schoolRolesHolding(m.permission) }))
      .filter((m) => m.roles.length > 0);
    expect(
      wrong.map((m) => `${m.key} is declared PLATFORM but ${m.permission} is held by ${m.roles.join(", ")}`),
    ).toEqual([]);
  });
});

describe("a SCHOOL-scoped trigger passes the caller's school to its sweep", () => {
  // The declaration is only worth as much as the handler. Each of these
  // controllers takes the principal and hands the sweep a school id — driven by
  // reading the call, because the whole defect was a declared scope the handler
  // did not honour.
  const routes: Array<{ file: string; call: RegExp }> = [
    { file: "privacy/archive.controller.ts", call: /archiveEndedTerms\("MANUAL", fleet \? undefined : p\.schoolId\)/ },
    { file: "privacy/compliance.controller.ts", call: /sweep\(fleet \? undefined : p\.schoolId\)/ },
    { file: "notifications/notification.controller.ts", call: /recoverStranded\("MANUAL", fleet \? undefined : p\.schoolId\)/ },
  ];

  it.each(routes)("$file scopes its manual run", ({ file, call }) => {
    const src = readFileSync(join(__dirname, "../../src", file), "utf8").replace(/\/\/[^\n]*/g, "");
    expect(src).toMatch(call);
    // ...and the fleet is reachable only through a PLATFORM permission.
    expect(src).toMatch(/OPERATOR_PERMISSIONS\.PLATFORM_OPERATE/);
  });
});
