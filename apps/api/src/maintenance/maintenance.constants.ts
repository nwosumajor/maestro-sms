// Partition maintenance (scaling Phase 5) — queue/job identifiers + defaults.

export const AUDIT_PARTITION_QUEUE = "audit-partition";
export const AUDIT_PARTITION_JOB = "audit-partition-ensure";
/** Stable repeatable-job id so re-registering on every boot is idempotent. */
export const AUDIT_PARTITION_SCHEDULER_ID = "audit-partition-daily";
/** 03:30 daily — before the retention (03:00) / dunning (04:00) neighbours clash. */
export const DEFAULT_AUDIT_PARTITION_CRON = "30 3 * * *";
/** How many months ahead to keep pre-created. Generous: the DEFAULT partition is
 *  only a safety net, and a partition costs nothing until it holds rows. */
export const AUDIT_PARTITION_MONTHS_AHEAD = 3;
