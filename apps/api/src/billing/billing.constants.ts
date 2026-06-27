// =============================================================================
// Platform billing — queue + DI constants
// =============================================================================

/** BullMQ queue for the scheduled dunning sweep (renewal reminders + past-due). */
export const BILLING_DUNNING_QUEUE = "billing-dunning";

/** Job name: flip overdue subscriptions to PAST_DUE + send renewal reminders. */
export const DUNNING_SWEEP_JOB = "dunning-sweep";

/** Stable id for the repeatable scheduler entry, so re-registration is idempotent. */
export const DUNNING_SCHEDULER_ID = "billing-dunning-daily";

/** Default sweep schedule (cron). Override with BILLING_DUNNING_CRON. */
export const DEFAULT_DUNNING_CRON = "0 4 * * *"; // 04:00 daily

/** Injection token for the privileged (RLS-bypassing) dunning DB client. */
export const BILLING_DATABASE = Symbol("BILLING_DATABASE");

/** Zero-UUID system actor for webhook-context tenant transactions (no HTTP user). */
export const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";
