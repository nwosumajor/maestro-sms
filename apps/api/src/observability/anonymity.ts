// =============================================================================
// Routes whose whole point is that nobody can tell who called them
// =============================================================================
// The poll module goes to real trouble over this. Its schema says "Identity is
// never revealed"; the vote's audit row is written under the SYSTEM actor, with
// the reason spelled out in the service — "naming the voter there handed
// leadership the roll of who answered a poll about leadership"; no read ever
// returns voterId alongside optionId; results are per-option tallies.
//
// The request log undid all of it. `customProps` attaches `user_id` to every
// line, so a vote produced:
//
//   POST /polls/a044c06b-…/vote   user_id c337f8f4-…   time 09:59:03.648
//
// and the vote row it created reads:
//
//   createdAt 09:59:03.635   label "Option A"
//
// Thirteen milliseconds apart. Anyone holding the application log and the
// database — operations, or anyone who obtains a log export — can recover not
// just WHO voted but WHAT THEY CHOSE, for every voter. The careful thing the
// audit trail does is worth nothing while a second record says the same fact
// in the same second.
//
// So these routes log everything else — method, route, status, latency, tenant,
// request id — and NOT who made the call. That is enough to debug a failing
// vote, and the one field that is missing is the one that breaks the promise.
//
// A ROUTE, not a flag. `/forms/:id/respond` is only anonymous when the form
// says so, and the logger cannot know that without a database read on the
// request path. Withholding the id from every form response costs operations
// nothing — the response row still records the respondent for a form that is
// not anonymous — while getting it wrong the other way silently breaks a
// promise the school made to a child.
// =============================================================================

/** One anonymity-bearing route, and why it is on this list. */
interface AnonymityBearingRoute {
  method: string;
  pattern: RegExp;
  why: string;
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

export const ANONYMITY_BEARING_ROUTES: AnonymityBearingRoute[] = [
  {
    method: "POST",
    pattern: new RegExp(`^/polls/${UUID}/vote/?$`),
    why: "every poll is anonymous by construction; the audit row is already SYSTEM",
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forms/${UUID}/respond/?$`),
    why: "a form may be anonymous, and the logger cannot know which without a read",
  },
];

/**
 * Should this request's log line withhold the caller's id?
 *
 * The query string is dropped before matching — pino strips it from the logged
 * URL for its own reasons, and a `?` would otherwise defeat the anchor.
 */
export function isAnonymityBearing(method: string | undefined, url: string | undefined): boolean {
  if (!method || !url) return false;
  const path = url.split("?")[0];
  const m = method.toUpperCase();
  return ANONYMITY_BEARING_ROUTES.some((r) => r.method === m && r.pattern.test(path));
}
