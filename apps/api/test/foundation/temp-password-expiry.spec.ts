// =============================================================================
// Temp passwords go stale — an unused credential must not live for ever
// =============================================================================
// A one-time temp password is a WORKING CREDENTIAL. The school-admin flow hands
// one to the console and it stays valid until used — for ever, if it never is.
// That is a standing password sitting in whatever chat it was pasted into, and
// platform staff (manager_admin) carry cross-tenant reach.
//
// The pure rule is tested here; the login wiring is exercised live.
// =============================================================================

import { isTempPasswordStale } from "../../src/foundation/auth.service";

// Bcrypt at cost factor 10 dominates this suite's runtime — that is the security
// parameter doing its job, not slow code, so the timeout moves rather than the
// cost. At the 5s default these pass alone and fail under full-suite
// parallelism, which teaches people to re-run a red suite instead of reading it.
jest.setTimeout(60_000);


const days = (n: number) => new Date(Date.now() - n * 86_400_000);

describe("isTempPasswordStale", () => {
  it("goes stale after 7 days, matching the invite link's life", () => {
    // One fact, not two that can disagree: "the invite expired" should mean the
    // link AND the password, or an owner re-issues one and the other lingers.
    expect(isTempPasswordStale(days(8), null)).toBe(true);
    expect(isTempPasswordStale(days(6), null)).toBe(false);
  });

  it("does not apply once the user has set their OWN password", () => {
    // After activation the temp credential is gone; a stale marker must never
    // start rejecting a real password.
    expect(isTempPasswordStale(days(365), new Date())).toBe(false);
  });

  it("treats NULL as unlimited, NOT expired", () => {
    // Rows predating the column hold temp passwords issued under the old rules.
    // Failing them closed would lock out every not-yet-activated admin on an
    // existing database — a hardening change turned into an outage. The
    // restrictive default is the right instinct in general and wrong here.
    expect(isTempPasswordStale(null, null)).toBe(false);
    expect(isTempPasswordStale(undefined, null)).toBe(false);
  });

  it("lets an ACTIVATED account through regardless of the marker", () => {
    // A user who activated and was later re-issued has passwordChangedAt nulled
    // by the re-issue, so activation only wins while it is the current state.
    expect(isTempPasswordStale(days(1), days(30))).toBe(false);
  });
});
