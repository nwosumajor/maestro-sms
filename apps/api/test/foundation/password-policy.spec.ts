// Password-reset policy — the pure expiry rule (security-critical).
import { isPasswordExpired } from "../../src/foundation/auth.service";

// Bcrypt at cost factor 10 dominates this suite's runtime — that is the security
// parameter doing its job, not slow code, so the timeout moves rather than the
// cost. At the 5s default these pass alone and fail under full-suite
// parallelism, which teaches people to re-run a red suite instead of reading it.
jest.setTimeout(60_000);


const DAY = 24 * 60 * 60 * 1000;

describe("isPasswordExpired (30-day reset policy)", () => {
  it("super_admin is exempt regardless of age", () => {
    expect(isPasswordExpired(new Date(Date.now() - 999 * DAY), true)).toBe(false);
    expect(isPasswordExpired(null, true)).toBe(false);
  });
  it("a null date counts as expired for non-super_admin (forces a change)", () => {
    expect(isPasswordExpired(null, false)).toBe(true);
  });
  it("older than 30 days is expired", () => {
    expect(isPasswordExpired(new Date(Date.now() - 31 * DAY), false)).toBe(true);
  });
  it("within 30 days is valid", () => {
    expect(isPasswordExpired(new Date(Date.now() - 29 * DAY), false)).toBe(false);
    expect(isPasswordExpired(new Date(), false)).toBe(false);
  });
});
