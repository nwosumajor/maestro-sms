/** Wiring for the hourly Art. 33 breach-deadline sweep. */
export const BREACH_DEADLINE_QUEUE = "breach-deadline";
export const BREACH_DEADLINE_SWEEP_JOB = "breach-deadline-sweep";
export const BREACH_DEADLINE_SCHEDULER_ID = "breach-deadline-scheduler";
/** HOURLY. The window is 72 hours: a daily sweep could first warn with four
 *  hours left, or notice a school was late a day after it happened. */
export const DEFAULT_BREACH_DEADLINE_CRON = "23 * * * *";
export const BREACH_DEADLINE_DATABASE = Symbol("BREACH_DEADLINE_DATABASE");
