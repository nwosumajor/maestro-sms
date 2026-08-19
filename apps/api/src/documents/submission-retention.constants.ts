export const SUBMISSION_RETENTION_QUEUE = "document-submission-retention";
export const SUBMISSION_RETENTION_JOB = "purge-declined-applicant-documents";
export const SUBMISSION_RETENTION_SCHEDULER_ID = "document-submission-retention-daily";
/** Nightly, well after the other sweeps: this one deletes objects from a bucket
 *  and there is nothing to be gained by racing the backups. */
export const DEFAULT_SUBMISSION_RETENTION_CRON = "50 3 * * *";
