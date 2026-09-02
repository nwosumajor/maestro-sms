// =============================================================================
// ONE definition of "a calendar day".
//
// `/^\d{4}-\d{2}-\d{2}$/` appeared FORTY-TWO times across the API and describes
// the SHAPE of a date rather than a date. It accepts `2026-04-31`,
// `2026-02-31`, `2026-13-45` and `0000-01-01`, and what happens next depends
// entirely on which reader gets it — which is the same failure the time-of-day
// validator had, one field over.
//
// MEASURED on the sharpest path, a staff member's LAST WORKING DAY:
//
//     2026-04-31   201  stored as 2026-05-01   <- a different MONTH
//     2026-02-31   201  stored as 2026-03-03
//     2026-11-31   201  stored as 2026-12-01   <- a different MONTH
//     2026-13-45   500  Internal server error
//     0000-01-01   201  stored as written
//
// The month roll is not cosmetic: `finalMonthAlreadyPaid` decides whether the
// leaver's final month has already been paid by looking at THE LAST WORKING
// DAY'S MONTH, and access is revoked on that day. A 31 April typed by somebody
// who meant 30 April moves both into May, silently, on a record that then
// drives money.
//
// The 500 is the other half and is the class this repo has fixed twice before
// (`?page=abc` reaching Prisma as `skip: NaN`; a raw cast before
// `MalformedIdFilter` could see it). A client typo must not become an internal
// error: it tells the caller nothing they can act on and it spends an alert.
// `probe:no-500` could never have found this one — it sweeps query strings, and
// this is a body field.
// =============================================================================

import { z } from "zod";

export const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The years a school date can sensibly fall in. Bounded because `0000-01-01` is
 * what a broken form default looks like, not a date anybody chose — and because
 * a birth date before 1900 or an expiry after 2200 is a typo in every case this
 * product has. Generous on purpose: it is a sanity bound, not a business rule.
 */
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

/**
 * Shape AND reality. The round trip is what separates them: JavaScript rolls
 * `2026-04-31` forward to 1 May rather than refusing it, so the only reliable
 * test is whether the date we get back is the date we were given.
 */
export function isIsoDay(v: string): boolean {
  const t = (v ?? "").trim();
  if (!ISO_DAY_PATTERN.test(t)) return false;
  const year = Number(t.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const d = new Date(`${t}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t;
}

/** The boundary schema. */
export const isoDay = z
  .string()
  .refine(isIsoDay, { message: "must be a real calendar day as YYYY-MM-DD" });
