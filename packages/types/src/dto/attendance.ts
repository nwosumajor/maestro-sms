// Attendance response DTOs. Student/class pickers reuse IdNameDto.

export interface AttendanceRecordDto {
  id: string;
  status: string;
  note: string | null;
  session: { classId: string; date: string };
}


/**
 * One class's register for a day, and WHO is responsible for it.
 *
 * The board answered "which registers are missing" and stopped there, so a head
 * teacher could see that Form 2B had none and not who to ask. It also listed
 * only the gaps — a count said "4 of 31 not taken" and the 27 that were done
 * were never shown, which is the half that tells you the day is under control.
 */
export interface RegisterStatusRowDto {
  classId: string;
  className: string;
  taken: boolean;
  /** Pupils marked, against those on roll — a register saved half way through
   *  reads as "done" everywhere else. */
  marked: number;
  enrolled: number;
  /** The class teacher (`Class.supervisorId`), or null where none is assigned. */
  teacherId: string | null;
  teacherName: string | null;
  /**
   * FALSE when there is no supervisor, or the one on record has left. Such a
   * register will never be chased by the daily reminder and cannot be, so the
   * board says so rather than showing an empty column: "nobody is assigned to
   * this class" is a different problem from "the teacher has not taken it".
   */
  teacherActive: boolean;
}

/**
 * Whether the daily reminder will chase this day, and why not.
 *
 * THE CASE THIS EXISTS FOR is a school that has never set up its academic
 * calendar: with no current term the sweep skips it, every day, for ever, and
 * the only trace is a `skipped` count in an operator console the school does
 * not open. A control that is silently off is worse than one that is missing,
 * because the board beside it goes on looking like the day is under control.
 *
 * `reason` is a CODE, not a sentence — the wording belongs to the screen.
 */
export type RegisterReminderOffReason = "NO_CURRENT_TERM" | "OUTSIDE_TERM" | "NON_SCHOOL_DAY" | "HOLIDAY";

export interface RegisterStatusDto {
  /** The SCHOOL's day, not the server's. */
  date: string;
  classes: RegisterStatusRowDto[];
  /** True when the daily reminder would chase outstanding registers for `date`. */
  remindersActive: boolean;
  /** Why it would not. Null when it would. */
  remindersOffReason: RegisterReminderOffReason | null;
}

/**
 * Which grain a compiled attendance history is cut at.
 *
 * Three, because three different questions get asked of the same record: a
 * MONTH is how a pattern is spotted ("every Monday in March"), a TERM is how the
 * school reports and what the report card states, and a SESSION is how a year is
 * compared with the one before it.
 */
export type AttendanceGrain = "month" | "term" | "session";

/** One compiled bucket of a pupil's attendance. */
export interface AttendanceBucketDto {
  /** Stable key — "2026-09" for a month, the term or session id otherwise. */
  key: string;
  /** "September 2026", "First Term", "2025/2026". */
  label: string;
  /** The window this bucket covers, inclusive. Null only where a term or session
   *  has no dates configured, which is itself worth seeing in an audit. */
  from: string | null;
  to: string | null;
  present: number;
  absent: number;
  late: number;
  excused: number;
  /** Registers this pupil appears in — the denominator, not the school's days. */
  total: number;
  /** `attendanceRatePct`: LATE attends, EXCUSED does not. Null when total is 0,
   *  because a rate over no registers is not 0% — it is unknown. */
  percent: number | null;
  /**
   * PROVENANCE, which is the point of the thing in an audit.
   *
   * ROLLUP — read from `attendance_term_rollup`, computed once when the term
   * ended and never recomputed, so it is what the school reported at the time.
   * LIVE — aggregated from the register records now. The current term is always
   * LIVE, because the rollup deliberately only covers ENDED terms; a reader who
   * cannot tell the two apart cannot tell a settled figure from a moving one.
   */
  source: "ROLLUP" | "LIVE";
}

/**
 * A pupil's attendance compiled for audit, at one grain.
 *
 * Paged over BUCKETS rather than records: a pupil's day rows are O(how long they
 * have been at the school), and an investigation opens years. Terms and sessions
 * are inherently few (three and one a year); months are ten. So the page is
 * generous and the count is exact.
 */
export interface AttendanceCompiledDto {
  studentId: string;
  studentName: string | null;
  grain: AttendanceGrain;
  buckets: AttendanceBucketDto[];
  /** Buckets that exist in total, so a page is never mistaken for the record. */
  total: number;
  page: number;
  pageSize: number;
  /** Totals across the pupil's WHOLE history, independent of the page — an audit
   *  that reports only what fitted on a page is worse than one that says nothing. */
  lifetime: { present: number; absent: number; late: number; excused: number; total: number; percent: number | null };
}
