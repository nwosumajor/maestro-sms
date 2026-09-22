// =============================================================================
// The monthly atom must not come back
// =============================================================================
// Subscription pricing is anchored on the SESSION. The term price is DERIVED
// from it and the school's own term count, so the 15% saving is a consequence of
// the arithmetic rather than a number somebody keeps true.
//
// The way that decays is not a wrong price — it is somebody reintroducing a
// per-month figure "just for display", or hard-coding 3 terms because that is
// what the platform's home country has. Both compile. Both are silently wrong in
// the United States and Canada, which run two semesters, and in any school on
// four quarters.
//
// So this gate reads the SOURCE, and computes the set it walks rather than
// naming files by hand.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";
import {
  BILLING_CYCLES,
  CALENDAR_TEMPLATES,
  PLANS,
  PLAN_PRICING_BY_CURRENCY,
  SESSION_DISCOUNT_PERCENT,
  computeSubscriptionPriceMinor,
  termsInSession,
} from "@sms/types";

const repoRoot = join(__dirname, "..", "..", "..", "..");

/** Every .ts/.tsx under a root, minus build output. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".next" || name === "coverage") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** Source with comments stripped — a rule must not be satisfied by the comment
 *  that explains it, which this repo has been caught by before. THE SHARED
 *  definition, not a hand-rolled one: `strip-comments.spec` fails any gate that
 *  writes its own, so a fix there reaches every gate at once. My first draft
 *  hand-rolled it and that gate caught it. */
const code = (file: string): string => stripComments(readFileSync(file, "utf8"));

describe("no per-month price survives anywhere", () => {
  const files = [
    ...walk(join(repoRoot, "packages", "types", "src")),
    ...walk(join(repoRoot, "apps", "api", "src")),
    ...walk(join(repoRoot, "apps", "web", "app")),
    ...walk(join(repoRoot, "apps", "web", "components")),
  ];

  it("scanned a real tree", () => {
    // No files, no offenders: a walk that finds nothing must never pass.
    expect(files.length).toBeGreaterThan(300);
  });

  it("nothing names a per-seat MONTHLY price", () => {
    const offenders = files.filter((f) => /perSeatMonthlyMinor/.test(code(f)));
    expect(offenders.map((f) => f.slice(repoRoot.length + 1))).toEqual([]);
  });

  it("no MONTH billing cycle is offered or compared", () => {
    const offenders = files.filter((f) => /BILLING_CYCLES\.MONTH|["']MONTH["']/.test(code(f)));
    expect(offenders.map((f) => f.slice(repoRoot.length + 1))).toEqual([]);
  });
});

describe("the 15% is arithmetic, not a claim", () => {
  it("holds for every tier, every priced currency and EVERY calendar shape", () => {
    const currencies = Object.keys(PLAN_PRICING_BY_CURRENCY);
    const templates = Object.keys(CALENDAR_TEMPLATES);
    expect(currencies.length).toBeGreaterThanOrEqual(3);
    expect(templates.length).toBeGreaterThanOrEqual(4);

    for (const currency of currencies) {
      const pricing = PLAN_PRICING_BY_CURRENCY[currency as keyof typeof PLAN_PRICING_BY_CURRENCY]!;
      for (const plan of Object.values(PLANS)) {
        for (const template of templates) {
          const terms = termsInSession(template);
          const seats = 1000;
          const perTerm = computeSubscriptionPriceMinor(plan, seats, BILLING_CYCLES.TERM, terms, pricing);
          const perSession = computeSubscriptionPriceMinor(plan, seats, BILLING_CYCLES.SESSION, terms, pricing);
          const saving = 1 - perSession / (perTerm * terms);
          const where = `${currency}/${plan}/${template}`;

          // TOLERANCE DERIVED FROM THE PRICE, not a round number pulled from
          // the air. The term price is rounded to a whole minor unit PER SEAT,
          // so the error is proportional to the price, not diluted by seats:
          // USD STANDARD is 191 cents a session, giving a 75c term price whose
          // half-cent rounding is 0.67% on its own. A fixed 0.1% tolerance would
          // fail that legitimately-correct row, and a fixed 1% would pass a
          // genuinely broken cheap currency. Half a minor unit over the exact
          // per-seat term price is the real bound.
          const exactPerSeatTerm =
            (pricing[plan].perSeatSessionMinor * 100) / (100 - SESSION_DISCOUNT_PERCENT) / terms;
          const tolerance = 0.5 / exactPerSeatTerm;
          expect([where, Math.abs(saving - SESSION_DISCOUNT_PERCENT / 100) <= tolerance]).toEqual([where, true]);
          // And whatever the rounding does, the session must never cost MORE.
          expect([where, perSession < perTerm * terms]).toEqual([where, true]);
        }
      }
    }
  });

  it("a session costs the same whatever the calendar — that is why it is the anchor", () => {
    const seats = 500;
    const prices = Object.keys(CALENDAR_TEMPLATES).map((t) =>
      computeSubscriptionPriceMinor(PLANS.ULTIMATE, seats, BILLING_CYCLES.SESSION, termsInSession(t)),
    );
    expect(new Set(prices).size).toBe(1);
  });
});
