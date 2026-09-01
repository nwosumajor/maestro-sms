import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";
import { PLANS, PLAN_PRICING, PLAN_PRICING_BY_CURRENCY, monthlyRunRateMinor } from "@sms/types";

/**
 * `platform-analytics.service.ts` explains at length why the payments block must
 * not add currencies together: "kobo added to cents, which is not money in any
 * currency ... a bug with a start date."
 *
 * The MRR roll-up THIRTY LINES ABOVE it did exactly that, reached a different
 * way: `PLAN_PRICING[plan].perSeatMonthlyMinor * seats`, where `PLAN_PRICING` is
 * the NAIRA fallback table. Every school's run-rate was a naira figure whatever
 * it is billed in, and the attention queue rendered it behind a hard-coded naira
 * sign. The subscription query did not even select the currency column.
 */

const src = (...p: string[]) =>
  stripComments(readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8"))
    
    ;

const ANALYTICS = src("apps", "api", "src", "operator", "platform-analytics.service.ts");
const ATTENTION = src("apps", "api", "src", "operator", "operator-attention.service.ts");
const QUEUE_UI = src("apps", "web", "components", "operator", "AttentionQueue.tsx");

describe("a school's run-rate is in the money it is billed in", () => {
  it("prices from the school's OWN currency, not the naira table", () => {
    const seats = 5;
    const ngn = monthlyRunRateMinor(PLAN_PRICING_BY_CURRENCY, PLANS.ENTERPRISE, "NGN", seats);
    const usd = monthlyRunRateMinor(PLAN_PRICING_BY_CURRENCY, PLANS.ENTERPRISE, "USD", seats);
    expect(ngn).toBe(PLAN_PRICING_BY_CURRENCY.NGN[PLANS.ENTERPRISE].perSeatMonthlyMinor * seats);
    expect(usd).toBe(PLAN_PRICING_BY_CURRENCY.USD[PLANS.ENTERPRISE].perSeatMonthlyMinor * seats);
    // The whole defect in one assertion: these are different amounts of
    // different money, and the old code produced the naira one for both.
    expect(usd).not.toBe(ngn);
    expect(ngn).toBe(PLAN_PRICING[PLANS.ENTERPRISE].perSeatMonthlyMinor * seats);
  });

  it("yields zero for a currency the platform does not price, never a naira figure", () => {
    // A school billed in money we do not price is an anomaly an operator should
    // see. Falling back to naira would hide it behind a plausible number.
    expect(monthlyRunRateMinor(PLAN_PRICING_BY_CURRENCY, PLANS.ENTERPRISE, "XOF", 5)).toBe(0);
    expect(monthlyRunRateMinor(PLAN_PRICING_BY_CURRENCY, PLANS.ENTERPRISE, "not-a-currency", 5)).toBe(0);
  });

  it("never returns a negative run-rate from a negative seat count", () => {
    expect(monthlyRunRateMinor(PLAN_PRICING_BY_CURRENCY, PLANS.ENTERPRISE, "NGN", -3)).toBe(0);
  });
});

describe("both services ask the same question, once", () => {
  it("neither computes a run-rate from the naira fallback table any more", () => {
    for (const [name, file] of [["analytics", ANALYTICS], ["attention", ATTENTION]] as const) {
      expect(`${name}:${/PLAN_PRICING\[/.test(file)}`).toBe(`${name}:false`);
      expect(file).toMatch(/monthlyRunRateMinor\(/);
    }
  });

  it("reads the operator's own prices, not the code defaults", () => {
    // A price the platform owner set must be the price their revenue figures
    // use — `effectiveAll` merges `plan_price` rows over the shipped lists.
    for (const file of [ANALYTICS, ATTENTION]) {
      expect(file).toMatch(/planPricing\.effectiveAll\(\)/);
    }
  });

  it("selects the currency column it depends on", () => {
    // It did not, which is why the naira table went unquestioned for so long.
    expect(ANALYTICS).toMatch(/schoolSubscription\.findMany\(\{[\s\S]{0,300}?currency: true/);
  });

  it("shares ONE definition of the platform's home currency", () => {
    // Analytics had grown a private HOME_CURRENCY and the queue a hard-coded
    // naira sign, while the constant already existed.
    expect(ANALYTICS).toMatch(/HOME_CURRENCY = PLATFORM_HOME_CURRENCY/);
    expect(ATTENTION).toMatch(/PLATFORM_HOME_CURRENCY/);
  });
});

describe("totals are never summed across currencies", () => {
  it("keeps the headline figures to the home currency and breaks out the rest", () => {
    expect(ANALYTICS).toMatch(/if \(mrrCurrency === HOME_CURRENCY\) \{[\s\S]{0,200}?mrrTotalMinor \+= monthly/);
    expect(ANALYTICS).toMatch(/byCurrency: \[\.\.\.mrrByCurrency\.entries\(\)\]/);
    expect(ANALYTICS).toMatch(/atRiskByCurrency: \[\.\.\.atRiskByCurrency\.entries\(\)\]/);
  });

  it("averages over the schools that contributed to the total", () => {
    // Dividing a naira total by a count including dollar-billed schools is an
    // average of nothing.
    expect(ANALYTICS).toMatch(/const home = mrrByCurrency\.get\(HOME_CURRENCY\)/);
    expect(ANALYTICS).not.toMatch(/Math\.round\(mrrTotalMinor \/ payingSchools\)/);
  });
});

describe("the console prints the school's own money", () => {
  it("no longer hard-codes a naira sign over a bare divide-by-100", () => {
    expect(QUEUE_UI).not.toMatch(/₦\$\{/);
    expect(QUEUE_UI).not.toMatch(/minor \/ 100/);
    expect(QUEUE_UI).toMatch(/formatMoney\(minor, currency/);
    expect(QUEUE_UI).toMatch(/runRate\(r\.mrrMinor, r\.mrrCurrency\)/);
  });
});
