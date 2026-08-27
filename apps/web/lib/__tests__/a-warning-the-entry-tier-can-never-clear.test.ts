/**
 * The dashboard warned every STANDARD school that its figures had failed.
 *
 * ANALYTICS is a PREMIUM add and the dashboard is ALWAYS-ON, so on the entry
 * tier `/analytics/overview` answers 404 — and `apiGet` returns null for a 404
 * exactly as it does for a network error or a 5xx. The page read that as "the
 * fetch failed" and rendered:
 *
 *   "Some figures could not be loaded, so they are shown as '—' or left out.
 *    Reload to try again — this is not a report that everything is at zero."
 *
 * Measured live with the demo school on STANDARD: /analytics/overview 404,
 * /dashboard/summary 200, and the amber banner present on every load. Reloading
 * could never clear it, because nothing had failed — the school simply does not
 * have the module.
 *
 * The cost is not only noise. That banner is how a PREMIUM school learns a
 * figure is genuinely missing; showing it permanently to the tier with the most
 * schools is how it stops being read at all.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = readFileSync(join(__dirname, "../../app/(app)/dashboard/page.tsx"), "utf8");

describe("a warning the entry tier can never clear", () => {
  it("does not ask for analytics the school has not bought", () => {
    // Gate BEFORE fetching, the rule this repo already records for permissions:
    // a refused call is not a failure to report, it is a call not to make.
    expect(PAGE).toMatch(/const hasAnalytics = mod\(MODULES\.ANALYTICS\)/);
    expect(PAGE).toMatch(/hasAnalytics \? apiGet<Overview>\("\/analytics\/overview"\) : Promise\.resolve\(null\)/);
  });

  it("only calls it a failure for a school that could have asked", () => {
    // Without this the distinction the whole block is built on — "could not
    // ask" versus "nothing there" — is lost for the tier that cannot ask.
    expect(PAGE).toMatch(/const overviewFailed = hasAnalytics && overview === null/);
  });

  it("keeps the banner for a school that DOES have analytics", () => {
    // The banner must not be deleted: for a PREMIUM school a null overview is a
    // real failure and saying nothing would report zeros as fact.
    expect(PAGE).toMatch(/someFiguresMissing/);
    expect(PAGE).toMatch(/Some figures could not be loaded/);
  });

  it("still distinguishes unknown from none in the figures themselves", () => {
    // Magnitude: the assertions above would pass against a page that dropped
    // the null-vs-zero handling entirely, which is the defect this banner and
    // the `num()` helper exist for.
    expect(PAGE).toMatch(/const num = \(value: number, unknown: boolean\)/);
    expect(PAGE).toMatch(/summaryFailed/);
  });
});
