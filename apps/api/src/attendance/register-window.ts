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
