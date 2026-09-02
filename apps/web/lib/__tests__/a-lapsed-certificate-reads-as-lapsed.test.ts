/**
 * The HR register rendered `expires {date} ({days}d)` for every document, so a
 * licence that lapsed a year ago read "expires 2024-06-01 (-823d)" — the future
 * tense about something that has already happened, in the same red as one
 * expiring in 29 days. The nightly notice had been fixed for exactly this
 * ("Staff document has EXPIRED"); the screen had not.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.join(process.cwd(), "components/hr/StaffLifecyclePanel.tsx"),
  "utf8",
);

describe("the HR document register says what has already happened", () => {
  it("keys on the server's stage rather than inferring from a negative day count", () => {
    expect(src).toMatch(/d\.expiryStage === "EXPIRED"/);
    // The old shape: one threshold for everything, which cannot tell "renew it
    // soon" from "this school is operating without it".
    expect(src).not.toMatch(/d\.daysUntilExpiry != null && d\.daysUntilExpiry < 30/);
  });

  it("says EXPIRED, not 'expires', once the day has passed", () => {
    expect(src).toMatch(/EXPIRED \$\{d\.expiresAt\.slice\(0, 10\)\} — no longer valid/);
  });

  it("still shows the countdown for one that has NOT expired", () => {
    // Losing the day count to fix the tense would be a worse register: "renew
    // it soon" needs to say how soon.
    expect(src).toMatch(/expires \$\{d\.expiresAt\.slice\(0, 10\)\}\$\{d\.daysUntilExpiry != null \? ` \(\$\{d\.daysUntilExpiry\}d\)`/);
  });

  it("distinguishes the two states visually, not only in words", () => {
    // A reader scanning a list sees colour before text.
    expect(src).toMatch(/EXPIRED"\s*\?\s*"font-medium text-destructive"/);
    expect(src).toMatch(/EXPIRING"\s*\?\s*"text-amber-600/);
  });

  it("still says so when there is no expiry at all", () => {
    expect(src).toMatch(/"no expiry"/);
  });
});
