// =============================================================================
// ONE definition of "a time of day".
//
// Six schemas across four modules each wrote their own, and they did not agree:
// the timetable and the exam planner required a real 24-hour clock
// (`([01]\d|2[0-3]):[0-5]\d`), while transport and every HR field accepted
// `\d{1,2}:\d{2}` — which takes `25:99`. A control written six times is right
// five times; this is the sixth.
//
// MEASURED, on the running stack, on the field that decides whether a member of
// staff is marked late:
//
//     lateAfter "99:99"  stored, 200      the same clock-in -> PRESENT
//     lateAfter "06:00"  the real setting the same clock-in -> LATE
//
// So a typo in that box switches lateness recording off for the whole school,
// silently and permanently — and staff attendance feeds lateness reports and
// pay.
//
// THE READERS ARE ALREADY DEFENSIVE, AND THAT IS THE PROBLEM RATHER THAN THE
// FIX: `hhmmToMinutes` correctly returns NaN, and the two comparators then
// handle it in OPPOSITE directions — `deriveClockInStatus` fails OPEN (everyone
// present) and `inClockInWindow` fails CLOSED (nobody may clock in at all).
// Neither is wrong on its own; a value that should never have been stored is
// what makes them disagree, so the control belongs at the boundary.
//
// ZERO-PADDED, because these are compared and sorted AS STRINGS: the trip list
// is `orderBy: { departTime: "asc" }` in SQL, where "9:30" sorts after "15:45".
// A person typing "9:30" by hand into a free-text box is not making a mistake,
// though, so the value is NORMALISED first and validated after.
// =============================================================================

import { z } from "zod";

/** A real 24-hour clock time, zero-padded. */
export const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `9:30` -> `09:30`; anything else is returned untouched for the check to refuse. */
export function normaliseHhmm(v: string): string {
  const t = (v ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : t;
}

export function isHhmm(v: string): boolean {
  return HHMM_PATTERN.test(normaliseHhmm(v));
}

/**
 * The boundary schema. Normalises then refuses, so what reaches the database is
 * always a real, sortable, zero-padded time.
 */
export const hhmm = z
  .string()
  .transform(normaliseHhmm)
  .refine((v) => HHMM_PATTERN.test(v), { message: "must be a time of day as HH:MM (00:00–23:59)" });
