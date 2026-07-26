// Feedback digest BullMQ wiring (mirrors billing.constants dunning).

export const FEEDBACK_DIGEST_QUEUE = "feedback-digest";
export const FEEDBACK_DIGEST_JOB = "feedback-digest-sweep";
export const FEEDBACK_DIGEST_SCHEDULER_ID = "feedback-digest-hourly";

/**
 * Default digest schedule (cron). At high volume (thousands/day) we do NOT email
 * the owner per submission — one email per hour with the backlog + new-count is
 * both cheaper and vastly more triageable. Override with FEEDBACK_DIGEST_CRON.
 */
export const DEFAULT_FEEDBACK_DIGEST_CRON = "0 * * * *"; // top of every hour

/** The trailing window a digest reports as "new". Matches an hourly cadence. */
export const FEEDBACK_DIGEST_WINDOW_MS = 60 * 60 * 1000;

/** Per-user flood cap: max submissions per rolling hour before a 429. */
export const FEEDBACK_USER_HOURLY_CAP = 30;
export const FEEDBACK_USER_WINDOW_MS = 60 * 60 * 1000;
