// =============================================================================
// Calendar recurrence — pure occurrence expansion
// =============================================================================
// ONE stored row describes a whole series; occurrences are expanded in memory
// for the window the caller asked for. Nothing is materialised as rows, so a
// weekly assembly costs one row instead of forty, and a series with no end date
// still cannot blow up — the window bounds it, and MAX_OCCURRENCES is a hard
// backstop against a pathological range.
// =============================================================================

export const RECURRENCES = ["NONE", "DAILY", "WEEKLY", "MONTHLY"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export const WEEKDAY_CODES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

/** Hard cap so a huge window (or a typo'd `until`) can never produce a runaway list. */
export const MAX_OCCURRENCES = 366;

const DAY_MS = 86_400_000;

export interface RecurrenceSpec {
  startsAt: Date;
  endsAt?: Date | null;
  recurrence?: string | null;
  recurrenceUntil?: Date | null;
  /** WEEKLY only. Empty ⇒ repeat on the start date's own weekday. */
  recurrenceDays?: string[] | null;
}

export interface Occurrence {
  startsAt: Date;
  endsAt: Date | null;
}

/**
 * `anchor` plus n months, clamped to the target month's length. Always measured
 * from the ORIGINAL anchor, never from the previous (already-clamped) result —
 * otherwise a 31st-of-the-month series would drift permanently after the first
 * short month (Jan 31 → Feb 28 → Mar 28 … instead of → Mar 31).
 */
const addMonths = (anchor: Date, n: number): Date => {
  const out = new Date(anchor.getTime());
  const day = anchor.getUTCDate();
  out.setUTCDate(1); // park on a day every month has before shifting
  out.setUTCMonth(out.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
};

/**
 * Expand a (possibly recurring) event into the occurrences that intersect
 * [windowStart, windowEnd]. A non-recurring event yields at most itself.
 * Deterministic and side-effect-free.
 */
export function expandOccurrences(spec: RecurrenceSpec, windowStart: Date, windowEnd: Date): Occurrence[] {
  const rule = (spec.recurrence ?? "NONE").toUpperCase();
  const durationMs = spec.endsAt ? Math.max(0, spec.endsAt.getTime() - spec.startsAt.getTime()) : null;
  const withEnd = (s: Date): Occurrence => ({
    startsAt: s,
    endsAt: durationMs === null ? null : new Date(s.getTime() + durationMs),
  });

  if (rule === "NONE" || !RECURRENCES.includes(rule as Recurrence)) {
    // Include it when the event itself overlaps the window at all.
    const end = durationMs === null ? spec.startsAt : new Date(spec.startsAt.getTime() + durationMs);
    return end >= windowStart && spec.startsAt <= windowEnd ? [withEnd(spec.startsAt)] : [];
  }

  // A series never runs past its `until`, nor past the requested window.
  const hardEnd = spec.recurrenceUntil && spec.recurrenceUntil < windowEnd ? spec.recurrenceUntil : windowEnd;
  if (spec.startsAt > hardEnd) return [];

  const out: Occurrence[] = [];
  const push = (d: Date) => {
    if (d < spec.startsAt || d > hardEnd) return;
    const end = durationMs === null ? d : new Date(d.getTime() + durationMs);
    if (end < windowStart) return; // finished before the window opened
    out.push(withEnd(d));
  };

  if (rule === "WEEKLY") {
    const codes = (spec.recurrenceDays ?? []).map((c) => c.toUpperCase());
    const days = codes.length > 0
      ? codes.map((c) => WEEKDAY_CODES.indexOf(c as WeekdayCode)).filter((i) => i >= 0)
      : [spec.startsAt.getUTCDay()];
    // Walk day by day from the later of (series start, window start).
    let cur = new Date(Math.max(spec.startsAt.getTime(), windowStart.getTime() - (durationMs ?? 0)));
    cur.setUTCHours(spec.startsAt.getUTCHours(), spec.startsAt.getUTCMinutes(), spec.startsAt.getUTCSeconds(), 0);
    while (cur <= hardEnd && out.length < MAX_OCCURRENCES) {
      if (days.includes(cur.getUTCDay())) push(new Date(cur.getTime()));
      cur = new Date(cur.getTime() + DAY_MS);
    }
    return out;
  }

  // Step by INDEX from the original start so MONTHLY keeps its anchor day.
  for (let n = 0; out.length < MAX_OCCURRENCES; n += 1) {
    const cur = rule === "DAILY" ? new Date(spec.startsAt.getTime() + n * DAY_MS) : addMonths(spec.startsAt, n);
    if (cur > hardEnd) break;
    push(cur);
  }
  return out;
}
