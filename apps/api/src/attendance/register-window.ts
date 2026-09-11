import type { TenantTx } from "../integrity/integrity.foundation";

/**
 * Is a register allowed to be written for this date at all?
 *
 * ONE definition, because there are two writers and they had drifted. The
 * register screen (`AttendanceService.markAttendance`) asked both questions on
 * adjacent lines; the ID-card scan desk, which also marks a pupil present,
 * asked neither — it was written as a COPY of the register's low-level write and
 * then stopped tracking it. That is the same reason its `ON CONFLICT` target
 * went stale when `attendance_record` was partitioned.
 *
 * Returns null when the day is open. `kind` is carried because the two callers
 * answer differently and legitimately so: the register screen REFUSES (a teacher
 * is asking to write a specific day and must be told why), while the scan desk
 * records the movement and simply does not mark the register — a gate terminal
 * must never lose the fact that somebody walked in.
 */
export type RegisterClosed = {
  kind: "HOLIDAY" | "TERM_CLOSED";
  reason: string;
};

/** Midnight UTC for a date — a `@db.Date` column stores days, not instants. */
export function dayUtcOf(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * Only EXPLICIT holidays block — weekends are left alone so a school that runs
 * Saturday classes is not broken. Fail-open when nothing is configured: an
 * unset-up school must never have attendance blocked.
 *
 * `today` is the SCHOOL's calendar day, resolved by the caller, and is used only
 * for the containing-term fallback — a term boundary flips at midnight WHERE THE
 * SCHOOL IS.
 */
export async function holidayOn(tx: TenantTx, date: Date): Promise<{ name: string } | null> {
  // A single INDEXED lookup for a span covering this day — never the whole table.
  const d = dayUtcOf(date);
  return tx.schoolHoliday.findFirst({
    where: { startDate: { lte: d }, endDate: { gte: d } },
    select: { name: true },
  });
}

/**
 * The start of the CURRENT term — the lock boundary. Prefers the explicitly
 * `isCurrent` term; falls back to the term whose range contains today. Null when
 * terms are not configured, which every caller treats as fail-open.
 */
export async function currentTermStartInTx(tx: TenantTx, today: Date): Promise<Date | null> {
  const marked = await tx.term.findFirst({ where: { isCurrent: true }, select: { startDate: true } });
  if (marked?.startDate) return marked.startDate;
  const containing = await tx.term.findFirst({
    where: { startDate: { lte: today }, endDate: { gte: today } },
    orderBy: { startDate: "desc" },
    select: { startDate: true },
  });
  return containing?.startDate ?? null;
}

export async function registerClosedReason(
  tx: TenantTx,
  date: Date,
  today: Date,
): Promise<RegisterClosed | null> {
  const holiday = await holidayOn(tx, date);
  if (holiday) {
    return {
      kind: "HOLIDAY",
      reason: `This date is a school holiday (${holiday.name}) — no register is taken. Remove the holiday if this is a school day.`,
    };
  }

  // A register dated BEFORE the current term's start is in a term that has ended
  // and is READ-ONLY for everyone, including leadership. Prefers the explicitly
  // `isCurrent` term; falls back to the term whose range contains today.
  const marked = await tx.term.findFirst({
    where: { isCurrent: true },
    select: { startDate: true },
  });
  let start = marked?.startDate ?? null;
  if (!start) {
    const containing = await tx.term.findFirst({
      where: { startDate: { lte: today }, endDate: { gte: today } },
      orderBy: { startDate: "desc" },
      select: { startDate: true },
    });
    start = containing?.startDate ?? null;
  }
  if (start && date < start) {
    return {
      kind: "TERM_CLOSED",
      reason:
        "This register is locked: it falls in a term that has ended. Past-term registers are read-only.",
    };
  }
  return null;
}

// =============================================================================
// Will the daily reminder chase this day — and if not, WHY NOT
// =============================================================================
// `registerClosedReason` above answers "may a register be WRITTEN for this
// date", which is a teacher's question and rightly fails open. The reminder asks
// something stricter: "is this a day whose missing registers are worth chasing".
// A holiday, a weekend or a school between terms is not.
//
// ONE definition, shared by the sweep that sends the reminders and the board
// that tells a head whether they are running. Two copies of this rule would
// drift, and the drift is invisible in the worst direction: a board saying
// registers are being chased while the sweep quietly skips the school.
//
// THE CASE THIS EXISTS FOR is `NO_CURRENT_TERM`. A school that has never set up
// its academic calendar gets no reminders AT ALL, for ever, and the only trace
// is a `skipped` count in an operator console the school never opens. Silence
// nobody can see is the failure this repo records over and over.
// =============================================================================

export type ReminderOffReason =
  /** No term is flagged current — the reminder cannot run, and nothing says so. */
  | "NO_CURRENT_TERM"
  /** There is a current term and this day falls outside it. */
  | "OUTSIDE_TERM"
  /** Saturday or Sunday. */
  | "NON_SCHOOL_DAY"
  /** A school holiday covers this day. */
  | "HOLIDAY";

export interface ReminderWindowFacts {
  isWeekend: boolean;
  hasCurrentTerm: boolean;
  /** True only when the term carries the dates to decide it — absent dates fail OPEN. */
  outsideTermDates: boolean;
  holiday: boolean;
}

/**
 * Null when the reminder will chase this day; otherwise why it will not.
 *
 * Order matters and is deliberate: a school with no calendar at all is the
 * finding worth reporting, so it outranks "it is a Saturday" — telling a head
 * "no registers are chased at weekends" when the real answer is "no registers
 * are ever chased" would be true and useless.
 */
export function reminderOffReason(f: ReminderWindowFacts): ReminderOffReason | null {
  if (!f.hasCurrentTerm) return "NO_CURRENT_TERM";
  if (f.outsideTermDates) return "OUTSIDE_TERM";
  if (f.holiday) return "HOLIDAY";
  if (f.isWeekend) return "NON_SCHOOL_DAY";
  return null;
}

/** Saturday or Sunday, for a `YYYY-MM-DD` in the SCHOOL's own calendar. */
export function isWeekendDay(localDate: string): boolean {
  const dow = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Does this day fall outside the term's dates?
 *
 * Fails OPEN on absent dates: a term that carries none cannot rule a day out,
 * and refusing to chase on that basis is silence nobody would notice. The
 * separate `NO_CURRENT_TERM` reason covers the case that really is a gap.
 */
export function outsideTermDates(
  term: { startDate: Date | null; endDate: Date | null } | null,
  day: Date,
): boolean {
  if (!term) return false;
  if (term.startDate && day < new Date(term.startDate)) return true;
  if (term.endDate && day > new Date(term.endDate)) return true;
  return false;
}
