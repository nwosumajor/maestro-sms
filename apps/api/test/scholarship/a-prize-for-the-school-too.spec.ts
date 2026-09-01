import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLANS,
  SCHOLARSHIP_SCHOOL_PRIZE_MONTHS,
  SCHOLARSHIP_SCHOOL_PRIZE_PLAN,
  SUBSCRIPTION_STATUS,
  effectivePlan,
  planRank,
} from "@sms/types";
import { stripComments } from "../support/strip-comments";

/**
 * A scholarship rewards the pupil with fees and the school that taught them
 * with free ENTERPRISE: a session for 1st, two terms for 2nd, one term for 3rd.
 *
 * THE GRANT IS NEVER WRITTEN OVER `plan`. That column is what the school BOUGHT
 * and what renewal is priced from — setting it to ENTERPRISE would bill a
 * STANDARD school at ENTERPRISE seats and leave them there for ever. It is a
 * time-boxed uplift resolved on READ, so it expires by DATE with no sweep to
 * run and nothing to repair, exactly as delinquency already does.
 */

const src = (...p: string[]) => stripComments(readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8"));
const ADMIN = src("apps", "api", "src", "scholarship", "scholarship-admin.service.ts");
const ENTITLEMENT = src("apps", "api", "src", "foundation", "module-entitlement.service.ts");
const DUNNING = src("apps", "api", "src", "billing", "billing-dunning.service.ts");

const future = new Date(Date.now() + 30 * 864e5);
const past = new Date(Date.now() - 864e5);

describe("what each position earns the school", () => {
  it("is a session, two terms and one term — in BILLED months", () => {
    // A session is three terms and NINE billed months here, not twelve:
    // holidays are not charged, which is what CYCLE_MONTHS.YEAR means.
    expect(SCHOLARSHIP_SCHOOL_PRIZE_MONTHS).toEqual({ 1: 9, 2: 6, 3: 3 });
    expect(SCHOLARSHIP_SCHOOL_PRIZE_PLAN).toBe(PLANS.ENTERPRISE);
  });
});

describe("a granted tier lifts a school while it lasts", () => {
  const granted = { plan: PLANS.ENTERPRISE, until: future };

  it("lifts a paying STANDARD school", () => {
    expect(effectivePlan(PLANS.STANDARD, SUBSCRIPTION_STATUS.ACTIVE, future, undefined, new Date(), granted))
      .toBe(PLANS.ENTERPRISE);
  });

  it("stops the moment it expires, by date alone", () => {
    expect(effectivePlan(PLANS.STANDARD, SUBSCRIPTION_STATUS.ACTIVE, future, undefined, new Date(), { plan: PLANS.ENTERPRISE, until: past }))
      .toBe(PLANS.STANDARD);
  });

  it("never DEMOTES a school that already pays for more", () => {
    // A school on ENTERPRISE winning a PREMIUM prize must not be dropped by
    // winning. The better of the two, never simply the granted one.
    expect(effectivePlan(PLANS.ENTERPRISE, SUBSCRIPTION_STATUS.ACTIVE, future, undefined, new Date(), { plan: PLANS.PREMIUM, until: future }))
      .toBe(PLANS.ENTERPRISE);
    expect(planRank(PLANS.ENTERPRISE)).toBeGreaterThan(planRank(PLANS.PREMIUM));
  });

  it("still lifts a school that has fallen delinquent", () => {
    // The prize was won; non-payment of their OWN plan is a separate matter,
    // and the platform gave this deliberately.
    expect(effectivePlan(PLANS.STANDARD, SUBSCRIPTION_STATUS.PAST_DUE, past, 0, new Date(), granted))
      .toBe(PLANS.ENTERPRISE);
  });

  it("changes nothing at all when there is no grant", () => {
    expect(effectivePlan(PLANS.PREMIUM, SUBSCRIPTION_STATUS.ACTIVE, future, undefined, new Date(), null))
      .toBe(effectivePlan(PLANS.PREMIUM, SUBSCRIPTION_STATUS.ACTIVE, future));
  });
});

describe("the award grants it, and the entitlement gate honours it", () => {
  it("writes a grant beside the purchased plan, never over it", () => {
    const m = ADMIN.slice(ADMIN.indexOf("private async grantSchoolPrize"));
    const body = m.slice(0, m.indexOf("\n  private "));
    expect(body).toMatch(/grantedPlan: SCHOLARSHIP_SCHOOL_PRIZE_PLAN/);
    expect(body).toMatch(/grantedUntil: until/);
    expect(body).not.toMatch(/\bplan:/); // the purchased column is untouched
  });

  it("EXTENDS an existing grant rather than replacing it", () => {
    // A school winning twice keeps both prizes; replacing would silently
    // shorten the first.
    const m = ADMIN.slice(ADMIN.indexOf("private async grantSchoolPrize"));
    expect(m.slice(0, 2000)).toMatch(/sub\.grantedUntil && sub\.grantedUntil > now \? sub\.grantedUntil : now/);
  });

  it("is best-effort, so a failed prize never unwinds a decided award", () => {
    // The pupil's money has already moved and the family has already been told.
    const m = ADMIN.slice(ADMIN.indexOf("private async grantSchoolPrize"));
    expect(m.slice(0, 3000)).toMatch(/catch \(e\)[\s\S]{0,200}?logger\.error/);
  });

  it("is read where modules are actually decided", () => {
    // Selected AND passed: selecting it and not passing it would leave the
    // prize invisible to the one place that gates a module.
    expect(ENTITLEMENT).toMatch(/grantedPlan: true/);
    expect(ENTITLEMENT).toMatch(/grantedUntil: true/);
    expect(ENTITLEMENT).toMatch(/effectivePlan\([\s\S]{0,160}?granted\)/);
  });

  it("drops the cache, or the prize waits ten minutes to appear", () => {
    expect(ADMIN).toMatch(/this\.modules\.invalidate\(schoolId\)/);
  });
});

describe("the school is warned before it ends", () => {
  it("warns inside a fixed horizon", () => {
    expect(DUNNING).toMatch(/GRANT_EXPIRY_NOTICE_DAYS = 14/);
    expect(DUNNING).toMatch(/grantedUntil: \{ gt: now, lte: horizon \}/);
  });

  it("warns ONCE, not every night", () => {
    expect(DUNNING).toMatch(/grantExpiryNoticeAt: null/);
    expect(DUNNING).toMatch(/data: \{ grantExpiryNoticeAt: now \}/);
  });

  it("a fresh prize earns a fresh warning", () => {
    const m = ADMIN.slice(ADMIN.indexOf("private async grantSchoolPrize"));
    expect(m.slice(0, 2500)).toMatch(/grantExpiryNoticeAt: null/);
  });

  it("says the bill does not change, which is the reader's real question", () => {
    expect(DUNNING).toMatch(/your bill does not change/);
  });

  it("cannot cost the dunning that already ran", () => {
    // Its own arm and its own try — the lesson the seat-arrears accrual records.
    expect(DUNNING).toMatch(/try \{\s*\n\s*grantsExpiring = await this\.warnExpiringGrants/);
  });

  it("reports what it did, so a quiet night is distinguishable", () => {
    expect(DUNNING).toMatch(/grantsExpiring,/);
  });
});
