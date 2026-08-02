// =============================================================================
// super_admin holds NO standing role-scope over a school's data
// =============================================================================
// Twenty-six services each kept their own "who sees everything" role set, and
// twenty-six of them listed `super_admin` in it. Nobody added that back door
// deliberately; each one was copied from the last, which is exactly how a
// cross-tenant privilege spreads without a single decision being made about it.
//
// It is defence in depth rather than an active hole: a platform user's JWT carries
// the PLATFORM org's school_id, so RLS confines them to an org with no pupils in
// it, and impersonation mints the TARGET user's roles — never super_admin. The
// entry only becomes live the day someone grants super_admin to an account inside
// a school, and on that day it grants a silent, unaudited read of every child's
// records in that school.
//
// The supported path to a tenant's data is impersonation: step-up gated, time
// limited, and audited against the operator by name. A standing role scope is none
// of those things.
//
// This test is a GATE, not a unit test. It reads the source rather than the
// behaviour, because the defect is a copied line — it reappears the next time
// somebody writes a new service by pattern-matching an old one.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".d.ts") ? [full] : [];
  });
}

/**
 * `const SOMETHING = new Set([...])` OR `const SOMETHING = [...]` — role scopes
 * are written BOTH ways in this codebase. Matched across newlines, since several
 * are formatted one role per line.
 *
 * The array form was originally missed, and `fees/payment-plans.service.ts` was
 * carrying `STAFF_WIDE = ["accountant", "school_admin", "principal",
 * "super_admin"]` — a standing super_admin scope over a tenant's payment plans,
 * invisible to this gate while it passed green. That is the exact "green test
 * worse than no test" failure the second case below was written to prevent,
 * reached through a hole in the SHAPE rather than rot in the regex.
 */
const ROLE_SET = /const\s+(\w+)\s*=\s*(?:new Set\(\s*)?\[([\s\S]*?)\]\s*\)?/g;

describe("super_admin has no standing role scope over tenant data", () => {
  it("appears in no service's role set", () => {
    const offenders: string[] = [];

    for (const file of tsFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const [, name, body] of source.matchAll(ROLE_SET)) {
        // Only role sets: a Set of permission keys or table names is not one.
        if (!/ROLE|WIDE|STAFF|ROSTER/i.test(name)) continue;
        if (/["']super_admin["']/.test(body)) {
          offenders.push(`${file.slice(SRC.length + 1)} — ${name}`);
        }
      }
    }

    // Named, so a failure says which file to open rather than just "something".
    expect(offenders).toEqual([]);
  });

  it("still finds the role sets it is meant to be policing", () => {
    // Guards the gate itself. A regex that silently stopped matching would make
    // this suite pass forever while checking nothing — the failure mode that makes
    // a green test worse than no test.
    let found = 0;
    for (const file of tsFiles(SRC)) {
      for (const [, name] of readFileSync(file, "utf8").matchAll(ROLE_SET)) {
        if (/ROLE|WIDE|STAFF|ROSTER/i.test(name)) found++;
      }
    }
    expect(found).toBeGreaterThan(20);
  });
});
