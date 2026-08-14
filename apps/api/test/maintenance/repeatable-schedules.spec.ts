// =============================================================================
// Changing a cron added a schedule instead of moving it
// =============================================================================
// BullMQ keys a repeatable by (name, pattern, jobId). Change the pattern and the
// old entry is not replaced — it stays in Redis and keeps firing, through every
// deploy, rebuild and restart, because nothing removes it.
//
// Found on the running stack, not by reading code: `exeat-overdue` had TWO
// schedules, `* * * * *` from an earlier build and the current `5 * * * *`. The
// every-minute one had fired 867 times against 26 for the real one. The sweep
// was running thirty times more often than its own source said, and would have
// gone on doing so indefinitely.
//
// The jobs console could not show it. It asks whether a job ran RECENTLY, so a
// job running sixty times an hour is the healthiest-looking row on the page —
// it was built to catch a sweep that stopped, and this is the opposite failure.
//
// Two of these queues move money (`fee-ops` posts late fees, `billing-dunning`
// charges saved cards). Both sweeps are idempotent, which is why a duplicated
// schedule was survivable rather than a bill.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pruneStaleRepeatables } from "../../src/common/repeatable";
import { SCHEDULED_JOBS } from "../../src/maintenance/job-runs.service";

const SRC = join(__dirname, "../../src");

function schedulers(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) schedulers(f, out);
    else if (f.endsWith(".scheduler.ts")) out.push(f);
  }
  return out;
}

describe("pruneStaleRepeatables", () => {
  const makeQueue = (jobs: Array<{ name: string; pattern: string; key: string }>) => {
    const removed: string[] = [];
    return {
      removed,
      queue: {
        getRepeatableJobs: jest.fn().mockResolvedValue(jobs),
        removeRepeatableByKey: jest.fn(async (k: string) => {
          removed.push(k);
          return true;
        }),
      } as never,
    };
  };

  it("removes a schedule whose pattern is no longer wanted", async () => {
    const { queue, removed } = makeQueue([
      { name: "sweep", pattern: "* * * * *", key: "old" },
      { name: "sweep", pattern: "5 * * * *", key: "current" },
    ]);
    const n = await pruneStaleRepeatables(queue, "sweep", ["5 * * * *"]);
    expect(n).toBe(1);
    expect(removed).toEqual(["old"]);
  });

  it("leaves a DIFFERENT job's schedules alone", async () => {
    // fee-ops carries two on purpose — a daily late-fee sweep and a weekly
    // reminder sweep — under different job names. Pruning by name is what keeps
    // this fix from deleting one of them.
    const { queue, removed } = makeQueue([
      { name: "late-fee", pattern: "20 5 * * *", key: "late" },
      { name: "reminder", pattern: "0 6 * * 1", key: "weekly" },
    ]);
    await pruneStaleRepeatables(queue, "late-fee", ["20 5 * * *"]);
    expect(removed).toEqual([]);
  });

  it("keeps every pattern the caller still wants", async () => {
    const { queue, removed } = makeQueue([
      { name: "sweep", pattern: "0 * * * *", key: "a" },
      { name: "sweep", pattern: "30 * * * *", key: "b" },
    ]);
    await pruneStaleRepeatables(queue, "sweep", ["0 * * * *", "30 * * * *"]);
    expect(removed).toEqual([]);
  });

  it("never throws — failing to prune must not stop the job registering", async () => {
    // Scheduling twice is bad; not scheduling at all is worse.
    const queue = {
      getRepeatableJobs: jest.fn().mockRejectedValue(new Error("redis down")),
      removeRepeatableByKey: jest.fn(),
    } as never;
    await expect(pruneStaleRepeatables(queue, "sweep", ["* * * * *"])).resolves.toBe(0);
  });
});

describe("every scheduler prunes before it registers", () => {
  const files = schedulers(SRC);

  it("finds the schedulers", () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  it.each(files.map((f) => [f.slice(SRC.length + 1)]))("%s", (rel) => {
    const src = readFileSync(join(SRC, rel as string), "utf8");
    expect(src).toContain("pruneStaleRepeatables(");
    // Before the add, or the stale entry survives this boot too.
    expect(src.indexOf("pruneStaleRepeatables(")).toBeLessThan(src.indexOf("this.queue.add("));
  });
});

describe("the catalogue matches the cron the code actually uses", () => {
  // The console judges lateness against `everyMinutes`. Declaring an HOURLY job
  // as daily makes that window 2.5 DAYS, so the row reads OK on a digest that
  // died yesterday morning.
  const CRON_DEFAULTS: Array<[string, string, number]> = [
    ["DEFAULT_FEEDBACK_DIGEST_CRON", "feedback/feedback.constants.ts", 60],
    ["DEFAULT_EXEAT_OVERDUE_CRON", "hostel/hostel.constants.ts", 60],
  ];

  it.each(CRON_DEFAULTS)("%s implies the catalogue's cadence", (name, file, expectedMinutes) => {
    const src = readFileSync(join(SRC, file as string), "utf8");
    const pattern = new RegExp(`${name} = "([^"]+)"`).exec(src)?.[1];
    expect(pattern).toBeDefined();
    // "m * * * *" fires hourly; "m h * * *" daily.
    const fields = (pattern as string).split(" ");
    const impliedMinutes = fields[1] === "*" ? 60 : 1440;
    expect({ name, impliedMinutes }).toEqual({ name, impliedMinutes: expectedMinutes });
  });

  it("the jobs catalogue agrees", () => {
    const byKey = Object.fromEntries(SCHEDULED_JOBS.map((j) => [j.key, j.everyMinutes]));
    expect(byKey["operator.feedbackDigest"]).toBe(60);
    expect(byKey["hostel.exeatOverdue"]).toBe(60);
  });
});
