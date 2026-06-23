// =============================================================================
// Assessment Integrity — queue + DI constants
// =============================================================================

/** BullMQ queue for async server-side detection (Golden Rule: detection is async). */
export const INTEGRITY_QUEUE = "integrity-detection";

/** Job name: run all server detectors over one submission. */
export const ANALYZE_SUBMISSION_JOB = "analyze-submission";

/** BullMQ queue for the scheduled retention/purge sweep (Golden Rule #5). */
export const INTEGRITY_RETENTION_QUEUE = "integrity-retention";

/** Job name: purge expired integrity telemetry across all tenants. */
export const PURGE_EXPIRED_JOB = "purge-expired";

/** Stable id for the repeatable scheduler entry, so re-registration is idempotent. */
export const RETENTION_SCHEDULER_ID = "integrity-retention-daily";

/** Default sweep schedule (cron). Override with INTEGRITY_RETENTION_CRON. */
export const DEFAULT_RETENTION_CRON = "0 3 * * *"; // 03:00 daily

/** Injection token for the privileged (RLS-bypassing) retention DB client. */
export const RETENTION_DATABASE = Symbol("RETENTION_DATABASE");

/** Injection token for the prose embedding provider (interface only here). */
export const EMBEDDING_PROVIDER = Symbol("EMBEDDING_PROVIDER");

/** Injection token for the foundation consent service (interface only here). */
export const CONSENT_SERVICE = Symbol("CONSENT_SERVICE");

export type IntegrityTrigger = "SUBMIT" | "AUTOSAVE";

/** Payload enqueued on submit/autosave. schoolId + userId captured under the
 *  verified JWT at enqueue time so the worker can re-establish tenant context. */
export interface AnalyzeSubmissionJob {
  schoolId: string;
  /** Actor that triggered the analysis (the student). For audit + tenant GUC. */
  userId: string;
  submissionId: string;
  trigger: IntegrityTrigger;
}
