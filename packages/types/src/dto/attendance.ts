// Attendance response DTOs. Student/class pickers reuse IdNameDto.

export interface AttendanceRecordDto {
  id: string;
  status: string;
  note: string | null;
  /**
   * WHO SAID SO, AND WHEN.
   *
   * A register is a legal record of where a child was, and the question an
   * investigation actually asks is not only "was this child marked absent on
   * the 12th" but "who recorded that, and has it been changed since". This
   * carried the status and the date alone, so the answer to both was on another
   * screen — the class register for that day — and only if the reader knew to
   * go and look, and which class to look in.
   *
   * `takenBy` is the member of staff the register is signed by
   * (`AttendanceSession.takenById`), null where that person has since been
   * removed; `recordedAt` is when the session was last written, so a mark that
   * was CORRECTED weeks later is visibly out of step with its own date; and
   * `className` saves the reader resolving a uuid by hand.
   */
  /**
   * When THIS PUPIL'S mark was first written — to the minute, in the school's
   * own zone when it is displayed.
   *
   * Per RECORD, not per session, because the two genuinely differ: a register
   * saved at 08:05 marks thirty pupils at once, and a gate scan at 08:41 marks
   * one of them present on its own. An investigation asking "when was this
   * child marked present" wants the second answer, and the session could only
   * ever give the first.
   */
  markedAt: Date;
  /**
   * When it was last CHANGED, or null if it never was.
   *
   * Null rather than "same as markedAt" so a reader never has to compare two
   * timestamps to work out whether they are looking at a correction — which is
   * the one thing about an old mark that an investigation is looking for.
   */
  amendedAt: Date | null;
  session: {
    classId: string;
    className: string | null;
    date: Date;
    takenBy: { id: string; name: string } | null;
  };
}


/**
 * A page of one pupil's day-by-day record, with the TRUE total.
 *
 * Declared so the service can be annotated: without a return type the shape was
 * inferred, so a field dropped here would have reached the page as `undefined`
 * and rendered as a blank cell — which on this screen is a claim about a child.
 */
export interface AttendanceHistoryPageDto {
  records: AttendanceRecordDto[];
  page: number;
  pageSize: number;
  /** Days in the whole record, not the page — an audit that reports only what
   *  fitted on a page is worse than one that says nothing. */
  total: number;
  from: string | null;
  to: string | null;
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
  /** The register was SAVED today. False while only the scan desk has marked
   *  pupils in (`marked` then counts the gate check-ins). */
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
  /**
   * May the READER of this board take this register?
   *
   * The server's own rule, so the UI never re-derives it. The board had no such
   * field and drew a "take" control on every row — including for a principal,
   * who may SEE every register and write none, and who was therefore offered the
   * button on all of them and refused only on SAVE, after marking the class.
   *
   * The rule is the class's NAMED supervisor, plus school_admin as cover; a head
   * who genuinely runs a class takes its register the moment they are named its
   * supervisor.
   */
  canTake: boolean;
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
  /**
   * Does this reader see attendance for the WHOLE school, or only the classes
   * they are attached to?
   *
   * The server's own answer (`SCHOOL_WIDE_ROLES`), carried so the page never
   * re-derives it — the same reason `canTake` is on each row. It decides SHAPE,
   * not access: a head or administrator gets the oversight boards, and a class
   * teacher gets their own register and nothing about anybody else's class.
   *
   * A teacher who supervises one class and teaches three others sees all four
   * on an oversight board, which reads as though the register might mix them.
   * It never did — the roster is the CLASS's enrolment and `canTake` is false
   * for the three — but a screen that has to be explained is a screen that will
   * be misread.
   */
  schoolWide: boolean;
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
   * Registers taken for a class this pupil was on the roll of, with NO mark for
   * them — shown, never folded into the rate. The rate cannot know whether the
   * child was there, so it is computed over what was recorded and this says how
   * much was not (`unrecordedCount` in the API's attendance/roll.ts).
   */
  unrecorded: number;
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
  lifetime: { present: number; absent: number; late: number; excused: number; total: number; percent: number | null; unrecorded: number };
  /**
   * Registers that fall in NO bucket at this grain — days the school took a
   * register outside every term it has configured.
   *
   * Always 0 for months, because every date is in some month. For terms and
   * sessions it is real and was invisible: measured on one demo pupil, the terms
   * summed to 162 against a lifetime of 193, so 16% of their record was missing
   * from the view and a reader adding the terms up would either think the tool
   * was broken or quietly cite the wrong total.
   *
   * Named rather than folded in, because the two readings differ: a register
   * outside every term is usually a gap in the CALENDAR, not in the child's
   * attendance, and an investigation needs to know which it is looking at.
   */
  outsideAnyBucket: number;
}
