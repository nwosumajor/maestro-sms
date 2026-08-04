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

  // Sequence order MUST match chronological order: every LOWER-sequence term ends
  // STRICTLY BEFORE this term begins, and every HIGHER-sequence term begins
  // strictly after it ends. This orders the calendar and forecloses overlap (a
  // strictly stronger check than a bare overlap test), so progression-by-sequence
  // can never disagree with the auto-advance-by-end-date it drives. The gap is
  // strict — terms may not share a boundary day — because report-card term
  // windows are INCLUSIVE date ranges, so a shared day would be counted in both
  // terms. Only enforced when BOTH ends of BOTH terms are dated (a half-configured
  // calendar stays permissive).
  if (start !== null && end !== null) {
    for (const t of siblings) {
      const ts = asDay(t.startDate);
      const te = asDay(t.endDate);
      if (ts === null || te === null) continue;
      if (t.sequence < proposed.sequence && te >= start) {
        return `"${t.name}" (term ${t.sequence}) must end before this term (term ${proposed.sequence}) begins — a later term cannot start earlier.`;
      }
      if (t.sequence > proposed.sequence && end >= ts) {
        return `This term (term ${proposed.sequence}) must end before "${t.name}" (term ${t.sequence}) begins — an earlier term cannot end later.`;
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
// Term presets — the canonical ordinal term slots
// -----------------------------------------------------------------------------
// The name-and-order pairing a school picks from, so a term is chosen from a
// dropdown (name) rather than a free-typed number that could be negative,
// duplicated, or out of order. The array INDEX is the source of truth for order;
// `sequence` is the stored value. Covers up to six periods (the DB/zod bound),
// which comfortably spans the Nigerian three-term year and semester systems.
export const TERM_PRESETS: ReadonlyArray<{ sequence: number; name: string }> = [
  { sequence: 1, name: "First Term" },
  { sequence: 2, name: "Second Term" },
  { sequence: 3, name: "Third Term" },
  { sequence: 4, name: "Fourth Term" },
  { sequence: 5, name: "Fifth Term" },
  { sequence: 6, name: "Sixth Term" },
];

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

// =============================================================================
// Calendar TEMPLATES — the year is not three terms everywhere
// =============================================================================
// `standardTermDates` lays out the Nigerian three-term year, and for a long time
// that was the only shape the product could express. A school running two
// semesters or four quarters had to hand-build every period and hand-name it.
//
// A template is a NAME and a rhythm, nothing more: the dates it produces are a
// starting point a school edits, exactly as the three-term generator always was.
// =============================================================================

export interface CalendarTemplate {
  key: string;
  label: string;
  /** Period names, in order. Length is the number of periods in a year. */
  periodNames: readonly string[];
  /** Teaching days per period. */
  periodDays: number;
  /** Days between periods. */
  breakDays: number;
}

export const CALENDAR_TEMPLATES: Record<string, CalendarTemplate> = {
  THREE_TERM: {
    key: "THREE_TERM",
    label: "Three terms (Nigeria, UK, Commonwealth)",
    periodNames: ["First Term", "Second Term", "Third Term"],
    periodDays: 90,
    breakDays: 21,
  },
  TWO_SEMESTER: {
    key: "TWO_SEMESTER",
    label: "Two semesters (United States, and much of Europe)",
    periodNames: ["Fall Semester", "Spring Semester"],
    periodDays: 135,
    breakDays: 28,
  },
  FOUR_QUARTER: {
    key: "FOUR_QUARTER",
    label: "Four quarters",
    periodNames: ["First Quarter", "Second Quarter", "Third Quarter", "Fourth Quarter"],
    periodDays: 63,
    breakDays: 14,
  },
  TRIMESTER: {
    key: "TRIMESTER",
    label: "Three trimesters",
    periodNames: ["First Trimester", "Second Trimester", "Third Trimester"],
    periodDays: 84,
    breakDays: 21,
  },
};

/** The platform's home shape. A school that has never chosen gets this, so
 *  nothing changes for anyone already live. */
export const DEFAULT_CALENDAR_TEMPLATE = "THREE_TERM";

export function calendarTemplate(key: string | null | undefined): CalendarTemplate {
  return CALENDAR_TEMPLATES[key ?? DEFAULT_CALENDAR_TEMPLATE] ?? CALENDAR_TEMPLATES[DEFAULT_CALENDAR_TEMPLATE];
}

/**
 * Lay out an academic year from a template. Pure and deterministic — no Date.now().
 *
 * `standardTermDates` is now this, with the three-term template; it is kept so
 * every existing caller and test is untouched.
 */
export function generateCalendar(templateKey: string | null | undefined, yearStart: string | Date): GeneratedTerm[] {
  const t = calendarTemplate(templateKey);
  const out: GeneratedTerm[] = [];
  let cursor = new Date(dayUtc(yearStart));
  for (let i = 0; i < t.periodNames.length; i += 1) {
    const periodStart = cursor;
    const periodEnd = addDays(periodStart, t.periodDays - 1);
    out.push({
      name: t.periodNames[i],
      sequence: i + 1,
      startDate: periodStart.toISOString().slice(0, 10),
      endDate: periodEnd.toISOString().slice(0, 10),
    });
    cursor = addDays(periodEnd, t.breakDays + 1);
  }
  return out;
}

// -----------------------------------------------------------------------------
// The session a school being set up TODAY should start with
// -----------------------------------------------------------------------------
// A newly provisioned school had no session and no terms at all. Nothing failed
// loudly: the past-term register lock reads the current term's start date and
// simply does not engage when there is no current term, marks and registers have
// no term to file against, and the archive sweep selects on a term end date it
// never finds. The school runs, unprotected, until somebody notices.
//
// So provisioning creates one. That means guessing a year, and the guess has to
// be right for a school joining at ANY point in the calendar — which is the same
// problem mid-year onboarding poses, one step earlier.
//
// The cutover is JULY rather than the September the year actually starts in.
// Third Term ends in early July under the standard shape, so from July onward a
// school being set up is preparing for the year AHEAD, not joining the one that
// is finishing. Setting the cutover at September instead would hand a school
// provisioned in August the session that had already ended.
//
// This is a starting point, not a ruling: both the session and its terms are
// editable, and the calendar panel says so when the dates do not match reality.
export function defaultSessionFor(today: Date, startMonth = 9): { name: string; yearStart: string } {
  const y = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1; // getUTCMonth is 0-indexed
  // Two months before the year opens, a school being set up is preparing for the
  // year AHEAD rather than joining the one finishing. Wraps for a January start,
  // where "two months before" is November of the PREVIOUS calendar year.
  const cutover = ((startMonth - 2 - 1 + 12) % 12) + 1;
  const wraps = cutover > startMonth; // e.g. start Jan (1), cutover Nov (11)
  const startYear = wraps ? (month >= cutover ? y + 1 : y) : month >= cutover ? y : y - 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    // A year that opens in January closes in the SAME calendar year, so naming it
    // "2027/2028" would misdescribe it on every report card.
    name: startMonth === 1 ? `${startYear}` : `${startYear}/${startYear + 1}`,
    yearStart: `${startYear}-${pad(startMonth)}-01`,
  };
}

/**
 * Which term a school being set up TODAY should open on.
 *
 * "The term containing today" is right only while a term is running. A school
 * provisioned during a break falls between two terms, and taking the first term
 * unconditionally hands it one that has ALREADY ENDED — so its first registers
 * file into a closed term and the past-term lock guards a window that is shut.
 * The term about to BEGIN is the one they will actually teach in.
 *
 * Returns an index into `terms`, which are assumed ordered by sequence.
 */
export function pickOpeningTerm(
  terms: Array<{ startDate: string | Date; endDate: string | Date }>,
  today: Date,
): number {
  if (terms.length === 0) return -1;
  const t = dayUtc(today);
  const containing = terms.findIndex((x) => dayUtc(x.startDate) <= t && t <= dayUtc(x.endDate));
  if (containing !== -1) return containing;
  // In a break, or before the year starts: the next term to open.
  const upcoming = terms.findIndex((x) => dayUtc(x.startDate) > t);
  if (upcoming !== -1) return upcoming;
  // The whole session is behind us — nothing ahead to point at.
  return terms.length - 1;
}
