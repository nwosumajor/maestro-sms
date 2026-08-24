// =============================================================================
// What the tier ladder must be true of, whatever the packaging decisions are
// =============================================================================
// Which module belongs in which tier is a COMMERCIAL decision and this file does
// not try to make it. What it pins is the set of properties that must hold under
// any packaging, because each one, if broken, sells something that does not
// exist or withholds something already paid for:
//
//   cumulative     a higher tier must contain everything below it, or an upgrade
//                  TAKES a module away — and every cross-module dependency in
//                  this product relies on it (hostel and transport fee runs post
//                  to invoices in FEES; CBT pushes into GRADEBOOK; analytics
//                  reads attendance). Cumulativity is what makes those safe.
//   no duplicates  a module listed in two ADD lists is a packaging edit waiting
//                  to go wrong in one place and not the other.
//   all sellable   a catalogue module in no plan can never be bought.
//   all described  a module in a plan with no catalogue entry is sold with no
//                  name and renders as a blank line on the pricing page.
//   all enforced   a module in a plan that gates NO controller is a promise with
//                  no product behind it — the school pays and gets nothing extra,
//                  or worse, everyone already had it. That is exactly how the
//                  ID-card scan desk came to be free on every tier.
//   priced upward  a higher tier that costs the same or less than a lower one is
//                  an arithmetic error nobody would notice until a bill.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MODULE_CATALOG, MODULES, PLANS, PLAN_MODULES, PLAN_PRICING, DEFAULT_PLAN, FALLBACK_PLAN } from "@sms/types";

const API_SRC = join(__dirname, "../../src");
const LADDER = [PLANS.STANDARD, PLANS.PREMIUM, PLANS.ULTIMATE, PLANS.ENTERPRISE] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".controller.ts")) out.push(f);
  }
  return out;
}

const gatedByAController = new Set<string>();
for (const f of walk(API_SRC)) {
  for (const m of readFileSync(f, "utf8").matchAll(/@RequireModule\(MODULES\.(\w+)\)/g)) {
    gatedByAController.add((MODULES as Record<string, string>)[m[1]]);
  }
}

describe("the tier ladder", () => {
  it("is strictly cumulative — an upgrade never takes a module away", () => {
    for (let i = 1; i < LADDER.length; i++) {
      const below = new Set(PLAN_MODULES[LADDER[i - 1]]);
      const missing = [...below].filter((m) => !PLAN_MODULES[LADDER[i]].includes(m));
      expect([LADDER[i], missing]).toEqual([LADDER[i], []]);
    }
  });

  it("adds something at every step, so each tier is worth buying", () => {
    for (let i = 1; i < LADDER.length; i++) {
      expect([LADDER[i], PLAN_MODULES[LADDER[i]].length]).toEqual([
        LADDER[i],
        expect.any(Number),
      ]);
      expect(PLAN_MODULES[LADDER[i]].length).toBeGreaterThan(PLAN_MODULES[LADDER[i - 1]].length);
    }
  });

  it("lists no module twice within a tier", () => {
    for (const plan of LADDER) {
      const mods = PLAN_MODULES[plan];
      expect([plan, mods.length]).toEqual([plan, new Set(mods).size]);
    }
  });

  it("can sell every module in the catalogue", () => {
    const top = new Set(PLAN_MODULES[PLANS.ENTERPRISE]);
    const unsellable = MODULE_CATALOG.map((c) => c.key).filter((k) => !top.has(k));
    expect(unsellable).toEqual([]);
  });

  it("describes every module it sells", () => {
    const described = new Set(MODULE_CATALOG.map((c) => c.key));
    const nameless = PLAN_MODULES[PLANS.ENTERPRISE].filter((k) => !described.has(k));
    expect(nameless).toEqual([]);
  });

  it("enforces every module it sells — no paid module gates nothing", () => {
    // The ID-card scan desk was a PREMIUM feature that no controller gated, so
    // every tier had it. This is the general form of that.
    const unenforced = PLAN_MODULES[PLANS.ENTERPRISE].filter((k) => !gatedByAController.has(k));
    expect(unenforced).toEqual([]);
  });

  it("charges more for more", () => {
    for (let i = 1; i < LADDER.length; i++) {
      const lower = PLAN_PRICING[LADDER[i - 1]].perSeatMonthlyMinor;
      const higher = PLAN_PRICING[LADDER[i]].perSeatMonthlyMinor;
      expect([LADDER[i], higher > lower]).toEqual([LADDER[i], true]);
    }
  });

  it("falls back to the BOTTOM of the ladder, never the middle", () => {
    // A delinquent school and a school with no row both land here; landing
    // anywhere but the floor would give away paid modules on a data gap.
    expect(FALLBACK_PLAN).toBe(LADDER[0]);
    expect(DEFAULT_PLAN).toBe(LADDER[0]);
  });

  it("found the controller tags at all", () => {
    // Without this the enforcement check above would pass by finding nothing.
    expect(gatedByAController.size).toBeGreaterThan(20);
  });
});
