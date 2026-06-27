// =============================================================================
// HR — queue + DI constants for the staff-document expiry reminder sweep
// =============================================================================

/** BullMQ queue for the daily cross-tenant staff-document expiry sweep. */
export const HR_REMINDER_QUEUE = "hr-reminder";

/** Job name: notify HR of staff documents expiring soon. */
export const HR_REMINDER_SWEEP_JOB = "hr-reminder-sweep";

/** Stable id for the repeatable scheduler entry (idempotent re-registration). */
export const HR_REMINDER_SCHEDULER_ID = "hr-reminder-daily";

/** Default sweep schedule (cron). Override with HR_REMINDER_CRON. */
export const DEFAULT_HR_REMINDER_CRON = "0 5 * * *"; // 05:00 daily

/** Injection token for the privileged (RLS-bypassing) reminder DB client. */
export const HR_REMINDER_DATABASE = Symbol("HR_REMINDER_DATABASE");

/** Roles that receive expiry reminders. */
export const HR_NOTIFY_ROLES = ["hr_clerk", "hr_manager", "school_admin", "principal"];
