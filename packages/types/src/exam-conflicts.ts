// =============================================================================
// Exam clash detection (pure, shared)
// =============================================================================
// A hall booked twice at the same time, or an invigilator rostered in two halls
// at once, is not a cosmetic scheduling annoyance — it is discovered on exam
// morning, with students already queuing. Timetabling has refused these since it
// was built (409 on teacher/room/class double-booking); exam sittings did not.
//
// The rule lives HERE, pure, for one reason: the server must REFUSE a clash, and
// the planning grid must SHOW one before you hit save. Two implementations of
// "do these overlap?" would eventually disagree, and the one that drifted would
// be the UI — quietly telling an exam officer a schedule is clean while the API
// rejects it, or worse, the reverse.
// =============================================================================

/** A sitting reduced to just what clash detection needs. */
export interface ClashCandidate {
  id: string;
  date: string; // YYYY-MM-DD
  startsAt: string; // HH:MM, 24h
  endsAt: string; // HH:MM, 24h
  hall: string;
  title: string;
}

/** Minutes since midnight for an "HH:MM" label; NaN-safe (returns -1). */
export function minutesOfDay(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? "").trim());
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return -1;
  return h * 60 + min;
}

/** Is `endsAt` strictly after `startsAt`, and are both parseable? */
export function isValidTimeRange(startsAt: string, endsAt: string): boolean {
  const s = minutesOfDay(startsAt);
  const e = minutesOfDay(endsAt);
  return s >= 0 && e >= 0 && e > s;
}

/**
 * Half-open overlap: [aStart, aEnd) vs [bStart, bEnd).
 *
 * Half-open is the point. Back-to-back exams — one ending 11:00, the next
 * starting 11:00 — are the NORMAL case in a school hall and must not be reported
 * as a clash. Using closed intervals would flag every consecutive pair and train
 * exam officers to ignore the warning, which is worse than not having it.
 */
export function timeRangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const as = minutesOfDay(aStart);
  const ae = minutesOfDay(aEnd);
  const bs = minutesOfDay(bStart);
  const be = minutesOfDay(bEnd);
  if (as < 0 || ae < 0 || bs < 0 || be < 0) return false; // unparseable: not our call to reject
  return as < be && bs < ae;
}

/** Hall labels compare case- and whitespace-insensitively ("Hall A" == "hall a"). */
export function sameHall(a: string, b: string): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/**
 * The first sitting in `others` that occupies the same hall at an overlapping
 * time. `others` should already be same-day; the date is re-checked anyway so a
 * caller passing a wider set still gets a correct answer.
 *
 * Returns the clashing candidate (so the caller can NAME it — "Hall A is taken by
 * Mathematics SS1, 09:00–11:00" is actionable, "conflict" is not), or null.
 */
export function findHallClash(
  candidate: Pick<ClashCandidate, "date" | "startsAt" | "endsAt" | "hall">,
  others: ClashCandidate[],
): ClashCandidate | null {
  for (const o of others) {
    if (o.date !== candidate.date) continue;
    if (!sameHall(o.hall, candidate.hall)) continue;
    if (timeRangesOverlap(candidate.startsAt, candidate.endsAt, o.startsAt, o.endsAt)) return o;
  }
  return null;
}

/**
 * The first sitting in `others` (the ones this person is already rostered on)
 * that overlaps the candidate. Unlike the hall check this ignores the hall
 * entirely — an invigilator cannot be in two places at once even if the halls
 * differ, which is exactly the case a hall-only check misses.
 */
export function findPersonClash(
  candidate: Pick<ClashCandidate, "date" | "startsAt" | "endsAt">,
  others: ClashCandidate[],
): ClashCandidate | null {
  for (const o of others) {
    if (o.date !== candidate.date) continue;
    if (timeRangesOverlap(candidate.startsAt, candidate.endsAt, o.startsAt, o.endsAt)) return o;
  }
  return null;
}

/** Human sentence for a clash, used verbatim in the 409 and in the grid badge. */
export function describeClash(kind: "hall" | "invigilator", clash: ClashCandidate): string {
  return kind === "hall"
    ? `${clash.hall} is already taken by "${clash.title}" (${clash.startsAt}–${clash.endsAt}) that day`
    : `Already invigilating "${clash.title}" (${clash.startsAt}–${clash.endsAt}) that day`;
}
