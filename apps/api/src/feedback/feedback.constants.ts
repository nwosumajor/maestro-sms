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

/**
 * Inbox-header stats are a FULL-TABLE aggregate (counting every row by status and
 * kind is exactly the question being asked, so no index can serve it). On an
 * append-only table that grows ~5000/day that scan reaches seconds within a few
 * years, and it runs on every operator page load. A short TTL makes the cost
 * per-minute instead of per-view; the numbers are a triage summary, so being up
 * to a minute stale is immaterial. (Mirrors PlanPricingService's 60s cache.)
 */
export const FEEDBACK_STATS_CACHE_MS = 60_000;
