export const RECORDING_RETENTION_QUEUE = "lms-recording-retention";
export const RECORDING_RETENTION_JOB = "purge-expired-class-recordings";
export const RECORDING_RETENTION_SCHEDULER_ID = "lms-recording-retention-daily";
/** Nightly, after the declined-applicant purge. Both delete objects from a
 *  bucket and there is nothing to be gained by racing each other or the backups. */
export const DEFAULT_RECORDING_RETENTION_CRON = "20 4 * * *";
/** Recordings removed per run. Each one is a separate bucket delete, and a
 *  sweep that tries to clear a year's backlog in one pass is a sweep that times
 *  out having done some unknowable fraction of it. */
export const RECORDING_RETENTION_BATCH = 200;
