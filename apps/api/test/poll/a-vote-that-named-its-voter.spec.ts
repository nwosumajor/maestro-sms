// =============================================================================
// The anonymous vote that the log named, to the millisecond
// =============================================================================
// The poll module takes anonymity seriously. Its schema says "Identity is never
// revealed"; the vote's audit row is written under the SYSTEM actor, and the
// service says why — "naming the voter there handed leadership the roll of who
// answered a poll about leadership"; no read returns voterId beside optionId;
// results are per-option tallies.
//
// The request log attached `user_id` to every line, including the vote. Measured
// live, one vote by one pupil:
//
//   log  POST /polls/a044c06b-…/vote   user_id c337f8f4-…   09:59:03.648
//   row  poll_vote                     "Option A"           09:59:03.635
//
// Thirteen milliseconds apart. Anyone holding the log and the database recovers
// not just who voted but what they chose, for everybody. The careful thing the
// audit trail does is worth nothing while a second record states the same fact
// in the same second.
//
// The fix withholds ONE field on TWO routes. Everything a failing vote is
// debugged from — method, route, status, latency, tenant, request id — is still
// logged.
// =============================================================================

import { isAnonymityBearing, ANONYMITY_BEARING_ROUTES } from "../../src/observability/anonymity";

const VOTE = "/polls/a044c06b-1c4b-413b-95c8-59580d19b3e7/vote";
const RESPOND = "/forms/a044c06b-1c4b-413b-95c8-59580d19b3e7/respond";

describe("which requests must not name their caller", () => {
  it("a poll vote", () => {
    expect(isAnonymityBearing("POST", VOTE)).toBe(true);
  });

  it("a form response", () => {
    // A route, not a flag: a form is only anonymous when it says so, and the
    // logger cannot know that without a read on the request path. Withholding
    // the id from every form response costs operations nothing.
    expect(isAnonymityBearing("POST", RESPOND)).toBe(true);
  });

  it("matches whatever case the method arrives in", () => {
    expect(isAnonymityBearing("post", VOTE)).toBe(true);
  });

  it("still matches with a query string attached", () => {
    // A `?` would otherwise defeat the anchor and quietly log the voter.
    expect(isAnonymityBearing("POST", `${VOTE}?utm=x`)).toBe(true);
  });

  it("and with a trailing slash", () => {
    expect(isAnonymityBearing("POST", `${VOTE}/`)).toBe(true);
  });
});

describe("what it deliberately does not cover", () => {
  it("READING the polls, which names nobody's choice", () => {
    // Over-withholding is not free: every id withheld is an incident somebody
    // cannot trace. Only the routes that carry a promise are on the list.
    expect(isAnonymityBearing("GET", "/polls")).toBe(false);
    expect(isAnonymityBearing("GET", VOTE)).toBe(false);
  });

  it("creating or closing a poll, which is an accountable staff action", () => {
    expect(isAnonymityBearing("POST", "/polls")).toBe(false);
    expect(isAnonymityBearing("POST", "/polls/a044c06b-1c4b-413b-95c8-59580d19b3e7/close")).toBe(false);
  });

  it("a path that merely looks like one", () => {
    // A loose pattern would start withholding ids from paths nobody vetted.
    expect(isAnonymityBearing("POST", "/polls/../vote")).toBe(false);
    expect(isAnonymityBearing("POST", "/pollsX/a044c06b-1c4b-413b-95c8-59580d19b3e7/vote")).toBe(false);
  });

  it("a missing method or url", () => {
    expect(isAnonymityBearing(undefined, VOTE)).toBe(false);
    expect(isAnonymityBearing("POST", undefined)).toBe(false);
  });
});

describe("the list itself", () => {
  it("says why each route is on it", () => {
    // A list of paths with no reasons is a list nobody can safely add to, or
    // safely remove from.
    for (const r of ANONYMITY_BEARING_ROUTES) {
      expect(r.why.length).toBeGreaterThan(20);
    }
  });

  it("is anchored at both ends", () => {
    // An unanchored pattern would match far more than intended — the failure
    // being silent, since over-withholding shows up only when somebody needs
    // the id and it is not there.
    for (const r of ANONYMITY_BEARING_ROUTES) {
      expect(r.pattern.source.startsWith("^")).toBe(true);
      expect(r.pattern.source.endsWith("$")).toBe(true);
    }
  });
});
