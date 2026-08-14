// =============================================================================
// Registering a repeatable job REPLACES its schedule
// =============================================================================
// BullMQ keys a repeatable by (name, pattern, jobId). Change the cron and you do
// not move the schedule — you add a second one, and the old one keeps firing
// forever because nothing ever removes it. It lives in Redis, so it survives
// every deploy, image rebuild and container restart.
//
// Found on the running stack: `exeat-overdue` had TWO schedules, `* * * * *`
// from an earlier build and the current `5 * * * *`. The every-minute one had
// fired 867 times against 26 for the real one — the sweep was running thirty
// times more often than its own code said, indefinitely, and no amount of
// reading that code would have shown it.
//
// The jobs console could not see it either: it asks whether a job has run
// RECENTLY, so a job running sixty times an hour is the healthiest-looking row
// on the page. It is built to catch a sweep that stopped, and this is the
// opposite failure.
//
// Two of these are money — `fee-ops` posts late fees, `billing-dunning` charges
// saved cards. A duplicated schedule there means extra sweeps on a real ledger.
// (Both are idempotent, which is why this was survivable rather than a bill.)
//
// NOT every duplicate is a mistake: `fee-ops` legitimately carries two — a daily
// late-fee sweep and a weekly reminder sweep. So this prunes by NAME and keeps
// only the patterns the caller currently wants, rather than assuming one each.
// =============================================================================

import type { Logger } from "@nestjs/common";
import type { Queue } from "bullmq";

/**
 * Remove any repeatable schedule for `jobName` whose pattern is not in
 * `keepPatterns`. Call BEFORE adding the current one.
 *
 * Best-effort by design: a scheduler must still register its job if the prune
 * fails, because failing to schedule is worse than scheduling twice.
 */
export async function pruneStaleRepeatables(
  queue: Queue,
  jobName: string,
  keepPatterns: string[],
  logger?: Logger,
): Promise<number> {
  try {
    const existing = await queue.getRepeatableJobs();
    let removed = 0;
    for (const r of existing) {
      if (r.name !== jobName) continue;
      if (r.pattern && keepPatterns.includes(r.pattern)) continue;
      await queue.removeRepeatableByKey(r.key);
      removed++;
      logger?.warn(
        `Removed a stale schedule for ${jobName}: "${r.pattern}" (superseded by ${keepPatterns.join(", ")}).`,
      );
    }
    return removed;
  } catch (err) {
    logger?.warn(`Could not prune stale schedules for ${jobName}: ${(err as Error).message}`);
    return 0;
  }
}
