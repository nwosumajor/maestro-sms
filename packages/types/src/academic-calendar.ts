// =============================================================================
// Academic calendar — pure validation, standard-session generation, teaching days
// =============================================================================
// Side-effect-free helpers shared by the API (enforcement) and, where useful,
// the web (preview). All dates are handled as UTC calendar days — a Term/Session
// startDate/endDate is a @db.Date, so only the y-m-d matters and time-of-day is
// ignored on purpose.
// =============================================================================

/** A term as seen by the validators — dates may be absent (not yet configured). */
export interface CalendarTerm {
  id: string;
  sessionId: string;
  name: string;
  sequence: number;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
}

/** A session window; dates optional until the leader sets them. */
export interface CalendarSession {
  id: string;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
}

/** Midnight-UTC epoch for a calendar day (time-of-day discarded). */
export function dayUtc(v: string | Date): number {
  const d = new Date(v);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const asDay = (v: string | Date | null | undefined): number | null =>
  v === null || v === undefined ? null : dayUtc(v);

/**
 * Validate ONE term's proposed dates against its session and siblings. Returns a
 * human-readable reason when invalid, or null when the dates are acceptable. The
 * caller supplies the sibling terms in the SAME session (excluding this term).
 *
 * Rules (each fail-OPEN when a needed date is absent — a half-configured calendar
 * is allowed, it just isn't cross-checked until both ends exist):
 *   1. endDate >= startDate.
 *   2. the term sits within its session's window (when the session is dated).
 *   3. no overlap with a sibling term's window.
 *   4. sequence is unique within the session.
 */
export function validateTermDates(
  proposed: { sequence: number; startDate?: string | Date | null; endDate?: string | Date | null },
  session: CalendarSession | null,
  siblings: CalendarTerm[],
): string | null {
  const start = asDay(proposed.startDate);
  const end = asDay(proposed.endDate);

  if (start !== null && end !== null && end < start) {
    return "A term's end date cannot be before its start date.";
  }

  if (session) {
    const sStart = asDay(session.startDate);
    const sEnd = asDay(session.endDate);
    if (start !== null && sStart !== null && start < sStart) {
      return "A term cannot start before its session begins.";
    }
    if (end !== null && sEnd !== null && end > sEnd) {
      return "A term cannot end after its session ends.";
    }
  }

  // Unique sequence within the session.
  if (siblings.some((t) => t.sequence === proposed.sequence)) {
    return `Another term in this session already uses sequence ${proposed.sequence}.`;
  }

  // Overlap: only checked when BOTH ends of BOTH terms are dated.
  if (start !== null && end !== null) {
    for (const t of siblings) {
      const ts = asDay(t.startDate);
      const te = asDay(t.endDate);
      if (ts === null || te === null) continue;
      if (start <= te && ts <= end) {
        return `These dates overlap "${t.name}" (${fmtDay(ts)}–${fmtDay(te)}).`;
      }
    }
  }

  return null;
}

/** Validate a session's own window (end >= start). */
export function validateSessionDates(input: { startDate?: string | Date | null; endDate?: string | Date | null }): string | null {
  const start = asDay(input.startDate);
  const end = asDay(input.endDate);
  if (start !== null && end !== null && end < start) {
    return "A session's end date cannot be before its start date.";
  }
  return null;
}

const fmtDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// -----------------------------------------------------------------------------
// Standard 3-term session generation (Tier 2 quick-create)
// -----------------------------------------------------------------------------

export interface GeneratedTerm {
  name: string;
  sequence: number;
  startDate: string; // ISO yyyy-mm-dd
  endDate: string;
}

/** Add whole days to a UTC calendar day, returning a fresh Date at 00:00 UTC. */
function addDays(base: Date, days: number): Date {
  return new Date(dayUtc(base) + days * 86_400_000);
}

/**
 * The Nigerian three-term academic year, laid out from a chosen year-start date.
 * Three ~13-week terms separated by ~3-week breaks — deliberately editable after
 * creation; this is a sensible starting point, not a mandate. Pure and
 * deterministic (no Date.now()).
 */
export function standardTermDates(yearStart: string | Date): GeneratedTerm[] {
  const TERM_DAYS = 90; // ~13 weeks of teaching
  const BREAK_DAYS = 21; // ~3 weeks between terms
  const names = ["First Term", "Second Term", "Third Term"];
  const start = new Date(dayUtc(yearStart));
  const out: GeneratedTerm[] = [];
  let cursor = start;
  for (let i = 0; i < 3; i += 1) {
    const termStart = cursor;
    const termEnd = addDays(termStart, TERM_DAYS - 1);
    out.push({
      name: names[i],
      sequence: i + 1,
      startDate: fmtDay(dayUtc(termStart)),
      endDate: fmtDay(dayUtc(termEnd)),
    });
    cursor = addDays(termEnd, BREAK_DAYS + 1);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Teaching days (Tier 3 — holidays / non-teaching days)
// -----------------------------------------------------------------------------

/** A closed [start,end] non-teaching span (single-day when start === end). */
export interface HolidaySpan {
  startDate: string | Date;
  endDate: string | Date;
}

/** Saturday/Sunday in UTC. Schools that teach on Saturday pass includeSaturday. */
export function isWeekend(date: string | Date, includeSaturday = true): boolean {
  const dow = new Date(dayUtc(date)).getUTCDay(); // 0 = Sun, 6 = Sat
  return dow === 0 || (includeSaturday && dow === 6);
}

/** True when `date` falls inside any holiday span (inclusive). */
export function isHoliday(date: string | Date, holidays: HolidaySpan[]): boolean {
  const d = dayUtc(date);
  return holidays.some((h) => d >= dayUtc(h.startDate) && d <= dayUtc(h.endDate));
}

/**
 * A real school day: not a weekend and not inside a holiday span. `includeWeekend`
 * lets a school that runs Saturday classes count them (Sunday is always off).
 */
export function isTeachingDay(
  date: string | Date,
  holidays: HolidaySpan[],
  opts: { saturdayIsSchoolDay?: boolean } = {},
): boolean {
  if (isWeekend(date, !opts.saturdayIsSchoolDay)) return false;
  return !isHoliday(date, holidays);
}

/** Count teaching days in the inclusive [from,to] window (bounded loop). */
export function countTeachingDays(
  from: string | Date,
  to: string | Date,
  holidays: HolidaySpan[],
  opts: { saturdayIsSchoolDay?: boolean } = {},
): number {
  const start = dayUtc(from);
  const end = dayUtc(to);
  if (end < start) return 0;
  let n = 0;
  for (let d = start; d <= end; d += 86_400_000) {
    if (isTeachingDay(new Date(d), holidays, opts)) n += 1;
  }
  return n;
}
