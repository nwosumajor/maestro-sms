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

// --- daily register reminder ------------------------------------------------
export const REGISTER_REMINDER_QUEUE = "register-reminder";
export const REGISTER_REMINDER_JOB = "register-reminder-hourly";
/**
 * HOURLY, for a once-a-day reminder. A fleet spans timezones, so the sweep asks
 * each school what its own clock reads and acts only on the tick that matches
 * `REGISTER_REMINDER_LOCAL_HOUR`. One tick in twenty-four does the work per
 * school; the other twenty-three cost one query each.
 */
export const DEFAULT_REGISTER_REMINDER_CRON = "10 * * * *";
