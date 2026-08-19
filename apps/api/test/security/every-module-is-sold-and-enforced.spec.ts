// =============================================================================
// A module has to be both SELLABLE and ENFORCED, or one of them is a lie
// =============================================================================
// Module entitlements are the second gate above RBAC: which product a school's
// subscription turns on. That makes each key two separate promises, in two
// separate files, and nothing has ever checked they agree:
//
//   IN A PLAN        somebody can buy it. A module in no tier is unreachable
//                    however well it works — it can only be switched on by a
//                    per-school override.
//   ENFORCED         buying it changes something. A key no controller carries
//                    is a line on an invoice that gates nothing, and a school
//                    on the cheapest tier gets it anyway.
//
// The failure is quiet in both directions: nobody complains about a feature
// they were given for free, and nobody notices a tier that sells air until a
// customer asks what they paid for.
//
// The plan side is read from the REAL data rather than parsed out of the source
// — PLAN_MODULES is composed from spreads of named arrays, and a first pass at
// this reported all 27 modules as sold by no tier because `MODULES.X` never
// appears in that literal. Reading the values makes that class of mistake
// impossible.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MODULES, PLAN_MODULES, MODULE_CATALOG } from "@sms/types";

const SRC = join(__dirname, "../../src");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

const source = walk(SRC)
  .filter((p) => !p.includes(".spec."))
  .map((p) => readFileSync(p, "utf8"))
  .join("\n");

const entries = Object.entries(MODULES) as Array<[string, string]>;
const soldSomewhere = new Set(Object.values(PLAN_MODULES).flat());

describe("the module catalogue", () => {
  it("is found at all — a scan that reads nothing would pass everything below", () => {
    expect(entries.length).toBeGreaterThanOrEqual(20);
    expect(source).toContain("@RequireModule(");
  });

  it.each(entries)("%s is included in at least one plan", (_name, key) => {
    // Otherwise it can only ever be switched on by a per-school override, and
    // no amount of paying will reach it.
    expect(soldSomewhere.has(key as never)).toBe(true);
  });

  it.each(entries)("%s is enforced by a controller", (name) => {
    // Otherwise the entitlement is decorative: every school has it, including
    // the ones that did not buy it.
    expect(source).toMatch(new RegExp(`@RequireModule\\(MODULES\\.${name}\\b`));
  });

  it("has a catalogue entry for every key, so a buyer can see what it is", () => {
    // MODULE_CATALOG is an ARRAY of {key,label,description}, not a map — a first
    // pass indexed it by key and reported all 27 as undescribed, which is what
    // an assertion looks like when it is wrong about the shape rather than the
    // data.
    const described = new Set(MODULE_CATALOG.map((m) => m.key));
    for (const [, key] of entries) expect(described.has(key as never)).toBe(true);
    expect(MODULE_CATALOG.every((m) => m.label && m.description)).toBe(true);
  });

  it("ladders upward, so a higher tier never takes something away", () => {
    // A customer upgrading must not lose a module. Each tier is a superset of
    // the one below by construction (spreads), and this keeps it that way.
    const order = ["STANDARD", "PREMIUM", "ULTIMATE", "ENTERPRISE"] as const;
    for (let i = 1; i < order.length; i++) {
      const lower = new Set(PLAN_MODULES[order[i - 1]]);
      const higher = new Set(PLAN_MODULES[order[i]]);
      for (const m of lower) expect(higher.has(m)).toBe(true);
      expect(higher.size).toBeGreaterThanOrEqual(lower.size);
    }
  });
});
