export const PAYMENT_HEALTH_QUEUE = "payment-health";
export const PAYMENT_HEALTH_JOB = "payment-health-check";
export const PAYMENT_HEALTH_SCHEDULER_ID = "payment-health-daily";
/** 06:15 UTC — early enough that a broken rail is known before the school day,
 *  and offset from the other sweeps so they do not all wake together. */
export const DEFAULT_PAYMENT_HEALTH_CRON = "15 6 * * *";
