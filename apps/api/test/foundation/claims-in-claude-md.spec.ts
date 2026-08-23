// =============================================================================
// The contract file has to be true
// =============================================================================
// CLAUDE.md is loaded into context every session and is what every decision here
// is taken against. A stale claim in it is not a documentation nit: it is a
// premise, and everything reasoned from it inherits the error.
//
// Checked, and it had rotted:
//
//   "18 school roles"          19 are seeded, 17 of them school-scoped, and the
//                              paragraph had never heard of manager_admin — a
//                              real role added by the platform permission split
//   "all 24 RLS files"         112
//   "71 RLS-enabled tenant     196
//    tables"
//
// The last two sit inside a paragraph headed "FULL-STACK VERIFIED (2026-06-27)",
// which was TRUE on that date. Rewriting a dated record would falsify history, so
// it is marked as a snapshot and points at the gate that keeps coverage honest
// now — `rls.e2e-spec.ts` computes its set from `pg_class` rather than counting
// by hand. The role sentence is present tense, so it is corrected.
//
// This test is the same instrument `pricing-consistency.test.ts` already applies
// to the owner-facing documents: read the file from disk and assert it states
// what the constants say. A number typed into prose rots the moment the code
// moves; a number a test reads cannot.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_PERMISSIONS } from "@sms/types";

const DOC = readFileSync(join(__dirname, "../../../../CLAUDE.md"), "utf8");
const ROLES = Object.keys(ROLE_PERMISSIONS);
/** The two that are not scoped to a school. Everything else is a school role. */
const PLATFORM_ROLES = ["super_admin", "manager_admin"];

describe("the RBAC paragraph", () => {
  it("names every role that is actually seeded", () => {
    // manager_admin was missing for months. A reader planning a change around
    // "the roles" would not have known it existed.
    const missing = ROLES.filter((r) => !DOC.includes(r));
    expect(missing).toEqual([]);
  });

  it("states the right total", () => {
    const words: Record<number, string> = { 17: "SEVENTEEN", 18: "EIGHTEEN", 19: "NINETEEN", 20: "TWENTY" };
    const expected = words[ROLES.length];
    expect([ROLES.length, expected]).not.toEqual([ROLES.length, undefined]);
    expect(DOC).toContain(`${expected} roles in all`);
  });

  it("states the right split between school and platform", () => {
    const school = ROLES.filter((r) => !PLATFORM_ROLES.includes(r)).length;
    expect(DOC).toContain(`${school} school-scoped`);
  });

  it("does not still claim a count that has been superseded", () => {
    // The specific sentence this test was written for.
    expect(DOC).not.toMatch(/— 18 school roles/);
  });
});

describe("the global-tables paragraph", () => {
  it("names every table that genuinely has no row security", () => {
    // "List them; never leave it implicit" was an instruction nothing enforced.
    // rls.e2e-spec.ts gates the set against the database; this checks the prose
    // agrees, so a reader is not told a different story from the gate.
    for (const t of ["_prisma_migrations", "school", "role", "permission", "role_permission", "ultimate_competition", "ultimate_participant"]) {
      expect([t, DOC.includes(t)]).toEqual([t, true]);
    }
  });

  it("does not call a table with restrictive policies 'RLS-exempt'", () => {
    // plan_price and its siblings are global AND have RLS enabled with app-role
    // SELECT-only policies. Calling that "exempt" undersells the posture, and a
    // reader deciding whether a new global table needs policies would take the
    // wrong lesson.
    expect(DOC).toMatch(/"global" is NOT the same as "unprotected"|global. is NOT the same as .unprotected/);
  });
});

describe("the dated verification record", () => {
  it("is marked as a snapshot rather than read as current", () => {
    // Its numbers were true on 2026-06-27 and are not now. Left as history —
    // rewriting a dated record would falsify it — but labelled, so nobody reads
    // "71 tenant tables" as today's coverage.
    const at = DOC.indexOf("FULL-STACK VERIFIED end-to-end (2026-06-27)");
    expect(at).toBeGreaterThan(-1);
    expect(DOC.slice(at, at + 400)).toMatch(/SNAPSHOT OF THAT DATE/);
  });

  it("points at the gate that is authoritative instead", () => {
    // The durable answer to a rotting count is a computed set, not a fresher
    // number: rls.e2e-spec.ts introspects pg_class and fails on an untested
    // tenant table.
    const at = DOC.indexOf("FULL-STACK VERIFIED end-to-end (2026-06-27)");
    expect(DOC.slice(at, at + 700)).toMatch(/rls\.e2e-spec\.ts/);
  });
});
