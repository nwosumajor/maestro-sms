// BullMQ wiring for the SIS profile-completion nudge (mirrors hr.constants).

export const SIS_NUDGE_QUEUE = "sis-nudge";
export const SIS_NUDGE_SWEEP_JOB = "sis-nudge-sweep";
export const SIS_NUDGE_SCHEDULER_ID = "sis-nudge-daily";

/** Default schedule. Override with SIS_NUDGE_CRON. */
export const DEFAULT_SIS_NUDGE_CRON = "0 6 * * *"; // 06:00 daily

/**
 * How long to wait before nudging the SAME pupil again.
 *
 * The sweep runs daily but nudges every 3 days: an unfinished profile is a chore,
 * not an emergency, and a daily email is how a reminder becomes noise people
 * filter out. `lastNudgedAt` is what makes the daily job idempotent.
 */
export const SIS_NUDGE_INTERVAL_DAYS = 3;

/** Cap per sweep so one enormous school can't monopolise a run. */
export const SIS_NUDGE_BATCH_MAX = 500;

/** The privileged (cross-tenant) client, provided like HR_REMINDER_DATABASE. */
export const SIS_NUDGE_DATABASE = Symbol("SIS_NUDGE_DATABASE");
