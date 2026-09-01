import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

/**
 * §2 shipped with NO web at all, and the result was a page contradicting
 * itself: a STANDARD school lifted to ENTERPRISE by a scholarship read
 * "Current plan: STANDARD" beside twenty-seven open modules, with nothing
 * saying why, until when, or what it costs. Measured live.
 *
 * A figure a reader cannot account for is one they stop trusting — including
 * the ones that are right. Three surfaces had to say it: the school's own
 * billing page, the operator editing that tenant, and the operator ABOUT TO
 * grant it.
 */

const src = (...p: string[]) => stripComments(readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8"));
const DTO = src("packages", "types", "src", "dto", "subscription.ts");
const ENTITLEMENT = src("apps", "api", "src", "foundation", "module-entitlement.service.ts");
const BILLING_PAGE = src("apps", "web", "app", "(app)", "billing", "page.tsx");
const SUB_MANAGER = src("apps", "web", "components", "operator", "SubscriptionManager.tsx");
const SCH_ADMIN = src("apps", "web", "components", "operator", "ScholarshipAdmin.tsx");

describe("the grant reaches the wire", () => {
  it("rides the subscription DTO every one of those screens already reads", () => {
    expect(DTO).toMatch(/granted: \{ plan: Plan; until: Date; reason: string \| null \} \| null;/);
    expect(ENTITLEMENT).toMatch(/granted: r\.granted/);
    expect(ENTITLEMENT).toMatch(/grantedReason: true/);
  });

  it("is NULL once it has expired, so no screen shows a dead prize", () => {
    // The gate resolves entitlement by date anyway; a screen still rendering
    // "ENTERPRISE until <a past date>" would be the contradiction inverted.
    expect(ENTITLEMENT).toMatch(/row\.grantedUntil > new Date\(\)/);
  });
});

describe("the school is told what it has and what it costs", () => {
  it("names the tier and the date beside the plan", () => {
    expect(BILLING_PAGE).toMatch(/data\.subscription\.granted && \(/);
    expect(BILLING_PAGE).toMatch(/data\.subscription\.granted\.plan/);
    expect(BILLING_PAGE).toMatch(/shortDate\(data\.subscription\.granted\.until, region\)/);
  });

  it("says the bill does NOT change, which is the reader's real question", () => {
    expect(BILLING_PAGE).toMatch(/your bill does not change/);
    expect(BILLING_PAGE).toMatch(/still \{data\.subscription\.plan\}/);
  });

  it("says what happens when it ends, rather than leaving it to be discovered", () => {
    expect(BILLING_PAGE).toMatch(/the\s*\n?\s*extra modules close/);
  });
});

describe("the operator sees it before acting", () => {
  it("shows a granted tier on the tenant they are editing", () => {
    // Without it: read "STANDARD", set STANDARD, and be unable to explain why
    // every module is still open.
    expect(SUB_MANAGER).toMatch(/setGranted\(sub\.granted \?\? null\)/);
    expect(SUB_MANAGER).toMatch(/On a granted \{granted\.plan\}/);
    expect(SUB_MANAGER).toMatch(/does not remove it/);
  });

  it("is told an award grants the SCHOOL months too, before they click", () => {
    // Two awards, not one. An operator committing the platform to months of a
    // paid tier should know before confirming, not afterwards from a row.
    expect(SCH_ADMIN).toMatch(/SCHOLARSHIP_SCHOOL_PRIZE_MONTHS\[pos as 1 \| 2 \| 3\]/);
    expect(SCH_ADMIN).toMatch(/also receives \$\{schoolMonths\} months of \$\{SCHOLARSHIP_SCHOOL_PRIZE_PLAN\}/);
    expect(SCH_ADMIN).toMatch(/Their own plan and bill are unchanged/);
  });

  it("says it again on success, so the record of what happened is complete", () => {
    expect(SCH_ADMIN).toMatch(/now has \$\{schoolMonths\} months/);
  });
});
