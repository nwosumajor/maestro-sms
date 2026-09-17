/** BullMQ queue + schedule for the staff attendance day-close sweep. */
export const STAFF_DAY_CLOSE_QUEUE = "staff-day-close";
export const STAFF_DAY_CLOSE_JOB = "staff-day-close-hourly";

/**
 * HOURLY, for a once-a-day close, and for the same reason the register reminder
 * is hourly: a fleet spans timezones, so there is no single instant that is
 * "after school" everywhere. Each school is closed on the tick where ITS OWN
 * clock reads `STAFF_DAY_CLOSE_LOCAL_HOUR`; the other twenty-three ticks
 * correctly do nothing, which is why `skipped` is a large healthy number here.
 *
 * Offset from the register reminder's :10 so the two sweeps do not contend.
 */
export const DEFAULT_STAFF_DAY_CLOSE_CRON = "40 * * * *";

/**
 * 19:00 local. Deliberately LATE — closing the day at 17:00 would file an ABSENT
 * against every member of staff running an evening activity, and an absence
 * wrongly recorded against a named person is the failure this sweep must not
 * introduce while fixing the opposite one.
 */
export const STAFF_DAY_CLOSE_LOCAL_HOUR = 19;
