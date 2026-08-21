/** BullMQ queue + schedule for the nightly attendance-rollup sweep. */
export const ATTENDANCE_ROLLUP_QUEUE = "attendance-rollup";
export const ATTENDANCE_ROLLUP_JOB = "rollup-ended-terms";

/**
 * 03:20 daily. Late enough that a term ending "today" is over everywhere the
 * platform runs, and offset from the other nightly sweeps so they do not all
 * contend for the same connections. Only ENDED terms are rolled up and the work
 * is idempotent, so a missed night costs nothing but a slower page.
 */
export const DEFAULT_ATTENDANCE_ROLLUP_CRON = "20 3 * * *";
