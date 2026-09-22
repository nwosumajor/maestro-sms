/**
 * The public price list must be SERVER-RENDERED, not baked at build time.
 *
 * `cache: "no-store"` on the pricing fetch is not enough on its own, and the
 * reason is subtle enough to be worth a gate. During `next build` the API is not
 * running, the fetch THROWS, and the page's catch swallows it — so Next never
 * observes the no-store call that would have marked the route dynamic. It
 * prerenders the page and serves it from the full route cache with
 * `s-maxage=31536000`.
 *
 * MEASURED: the operator's stored price read 500,000 while the homepage kept
 * showing 401,625 and `/api/public/plan-pricing` returned the new figure. It had
 * looked correct only because the fallback equals the shipped default — so the
 * page was right until the first time anybody changed a price, which is exactly
 * the day it matters.
 *
 * `/for-owners` already carried the line. The page with the actual price list
 * did not — the same sibling asymmetry this repo keeps finding.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const webRoot = join(__dirname, "..", "..");
const appRoot = join(webRoot, "app");

/** Public pages (outside the signed-in group) that read live platform data. */
function publicPagesReadingPricing(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name.startsWith("(app)")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "page.tsx" && /plan-pricing|PLAN_PRICING_BY_CURRENCY/.test(readFileSync(full, "utf8"))) {
        out.push(full);
      }
    }
  };
  walk(appRoot);
  return out;
}

describe("a public price list is never frozen at build time", () => {
  const pages = publicPagesReadingPricing();

  it("found the pages that publish prices", () => {
    // No files, no offenders: a walk that finds nothing must not pass.
    expect(pages.length).toBeGreaterThanOrEqual(1);
  });

  it.each(pages.map((p) => [p.slice(webRoot.length + 1), p]))(
    "%s is force-dynamic, so an operator price change shows on the next view",
    (_label, file) => {
      const src = readFileSync(file, "utf8");
      expect(src).toMatch(/export const dynamic\s*=\s*["']force-dynamic["']/);
    },
  );
});
