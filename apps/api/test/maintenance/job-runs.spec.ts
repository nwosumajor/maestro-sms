// =============================================================================
// Did the background jobs actually run?
// =============================================================================
// Thirteen jobs run on timers, and every one that moves money is among them:
// dunning, payment reconciliation, mobile-money recovery, late fees. Nothing
// recorded that any of them had run. The only trace was a log line, which needs
// shell access to read and is gone on rotation.
//
// That is the failure this platform was least equipped to notice, because it
// produces no error. A scheduler that stops — a Redis flush, a deploy that drops
// the repeatable job, a worker that never boots — simply goes quiet. From
// outside, "swept and found nothing" and "has not swept since March" are the
// same silence.
// =============================================================================

import { JobRunsService, SCHEDULED_JOBS } from "../../src/maintenance/job-runs.service";

function makeService(rows: Array<Record<string, unknown>> = [], client = true) {
  const create = jest.fn().mockResolvedValue({ id: "run-1" });
  const update = jest.fn().mockResolvedValue({});
  const svc = Object.create(JobRunsService.prototype) as JobRunsService;
  Object.assign(svc, {
    db: {
      client: client
        ? { jobRun: { create, update }, $queryRaw: jest.fn().mockResolvedValue(rows) }
        : null,
    },
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
  });
  return { svc, create, update };
}

describe("recording a run", () => {
  it("records the outcome and the job's own summary", async () => {
    const { svc, create, update } = makeService();
    const out = await svc.record("billing.dunning", "SCHEDULE", async () => ({ reminded: 3 }));
    expect(out).toEqual({ reminded: 3 });
    expect(create.mock.calls[0][0].data).toEqual({ job: "billing.dunning", trigger: "SCHEDULE" });
    // The summary is what makes "billed 0" and "0 because it never ran"
    // distinguishable after the fact.
    expect(update.mock.calls[0][0].data).toMatchObject({ ok: true, summary: { reminded: 3 } });
  });

  it("records a failure and RE-THROWS, so BullMQ still retries", async () => {
    // Swallowing the error here would make a broken job look successful to the
    // queue as well as to this table — the opposite of the point.
    const { svc, update } = makeService();
    await expect(
      svc.record("fees.reconciliation", "SCHEDULE", async () => {
        throw new Error("gateway down");
      }),
    ).rejects.toThrow("gateway down");
    expect(update.mock.calls[0][0].data).toMatchObject({ ok: false, error: "gateway down" });
  });

  it("still runs the job when the record cannot be written", async () => {
    // The record observes the work; it must never gate it. A sweep that refuses
    // to run because its logbook is full is a worse outcome than no logbook.
    const { svc } = makeService([], false);
    await expect(svc.record("sis.nudge", "SCHEDULE", async () => "done")).resolves.toBe("done");
  });

  it("still runs the job when OPENING the record throws", async () => {
    const { svc, create } = makeService();
    create.mockRejectedValueOnce(new Error("table missing"));
    await expect(svc.record("sis.nudge", "SCHEDULE", async () => "done")).resolves.toBe("done");
  });

  it("marks a hand-triggered run as MANUAL", async () => {
    // A run somebody triggered is not evidence the timer works, which is the
    // question the console exists to answer.
    const { svc, create } = makeService();
    await svc.record("fees.ops", "MANUAL", async () => ({}));
    expect(create.mock.calls[0][0].data.trigger).toBe("MANUAL");
  });
});

describe("the console's view", () => {
  it("lists every KNOWN job, not merely the ones that have run", async () => {
    // The whole point. Driving off the history would hide a job that has never
    // fired — which is the case this table exists for.
    const { svc } = makeService([]);
    const status = await svc.status();
    expect(status).toHaveLength(SCHEDULED_JOBS.length);
    expect(status.every((s) => s.neverRun)).toBe(true);
  });

  it("separates NEVER RUN from LATE", async () => {
    // Three states that look identical in a log file, and only one is fine.
    const old = new Date(Date.now() - 9 * 86_400_000);
    const { svc } = makeService([
      { job: "billing.dunning", startedAt: old, finishedAt: old, ok: true, trigger: "SCHEDULE", summary: {}, error: null },
    ]);
    const status = await svc.status();
    const dunning = status.find((s) => s.key === "billing.dunning")!;
    expect(dunning.neverRun).toBe(false);
    expect(dunning.overdue).toBe(true); // daily job, nine days quiet
    expect(status.find((s) => s.key === "sis.nudge")!.neverRun).toBe(true);
  });

  it("does not call a job late merely for being within its cadence", async () => {
    // An alert that cries wolf is one people turn off.
    const recent = new Date(Date.now() - 60_000);
    const { svc } = makeService([
      { job: "hostel.exeatOverdue", startedAt: recent, finishedAt: recent, ok: true, trigger: "SCHEDULE", summary: {}, error: null },
    ]);
    const s = (await svc.status()).find((x) => x.key === "hostel.exeatOverdue")!;
    expect(s.overdue).toBe(false);
  });

  it("asks the database for the newest run per job, not every run ever", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/maintenance/job-runs.service.ts"), "utf8");
    expect(src).toMatch(/DISTINCT ON \(job\)/);
  });
});

describe("the catalogue", () => {
  it("has a unique key per job", () => {
    const keys = SCHEDULED_JOBS.map((j) => j.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers every scheduled processor in the codebase", async () => {
    // A job wired to a timer but missing from the catalogue would never appear
    // on the console — invisible in exactly the way this change is about.
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d)) {
        const f = join(d, e);
        if (statSync(f).isDirectory()) walk(f, out);
        else if (e.endsWith(".scheduler.ts")) out.push(e);
      }
      return out;
    };
    const schedulers = walk(join(__dirname, "../../src"));
    expect(schedulers.length).toBe(SCHEDULED_JOBS.length);
  });
});

// =============================================================================
// The failure this console could not see
// =============================================================================
// It asked whether a job had run RECENTLY, so a sweep firing sixty times an hour
// was the healthiest-looking row on the page. That is how a stale every-minute
// repeatable hid in Redis for 874 firings while the code said hourly — the
// console reported OK throughout, because "ran a minute ago" was all it checked.
// =============================================================================
describe("a job running far too often", () => {
  const runsRow = (job: string, ago: number) => ({
    job, startedAt: new Date(Date.now() - ago), finishedAt: new Date(Date.now() - ago),
    ok: true, trigger: "SCHEDULE", summary: {}, error: null,
  });

  function withCounts(last: Array<Record<string, unknown>>, counts: Array<{ job: string; runs: number }>) {
    const svc = Object.create(JobRunsService.prototype) as JobRunsService;
    const $queryRaw = jest
      .fn()
      // status() asks for the newest run per job first, then the 24h counts.
      .mockResolvedValueOnce(last)
      .mockResolvedValueOnce(counts.map((c) => ({ job: c.job, runs: BigInt(c.runs) })));
    Object.assign(svc, {
      db: { client: { jobRun: { create: jest.fn(), update: jest.fn() }, $queryRaw } },
      logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
    });
    return svc;
  }

  it("flags an hourly job that fired 60 times an hour", async () => {
    // The real case: exeat-overdue is declared hourly (24/day) and was firing
    // every minute (~1440/day).
    const svc = withCounts([runsRow("hostel.exeatOverdue", 60_000)], [
      { job: "hostel.exeatOverdue", runs: 1440 },
    ]);
    const s = (await svc.status()).find((x) => x.key === "hostel.exeatOverdue")!;
    expect(s.overrunning).toBe(true);
    expect(s.expectedInDay).toBe(24);
    expect(s.runsInDay).toBe(1440);
    // And it is NOT late — which is exactly why the old console said OK.
    expect(s.overdue).toBe(false);
  });

  it("does not accuse a job that merely drifts", async () => {
    // An hourly job expects 24; 30 is drift, not a fault. An alert that cries
    // wolf is one people turn off.
    const svc = withCounts([runsRow("hostel.exeatOverdue", 60_000)], [
      { job: "hostel.exeatOverdue", runs: 30 },
    ]);
    const s = (await svc.status()).find((x) => x.key === "hostel.exeatOverdue")!;
    expect(s.overrunning).toBe(false);
  });

  it("ignores MANUAL runs when judging the timer", async () => {
    // Pressing "Run now" repeatedly must not make the console accuse an operator
    // of a fault they caused by asking. The count query filters on trigger.
    const svc = withCounts([], []);
    await svc.status();
    const sql = ((svc as unknown as { db: { client: { $queryRaw: jest.Mock } } }).db.client.$queryRaw)
      .mock.calls[1][0]
      .join("");
    expect(sql).toContain("trigger = 'SCHEDULE'");
    expect(sql).toContain("24 hours");
  });

  it("a daily job expects one run, not zero", async () => {
    // Rounding must never produce an expectation of 0, or every daily job would
    // read as over-running the moment it ran at all.
    const svc = withCounts([], []);
    const s = (await svc.status()).find((x) => x.key === "billing.dunning")!;
    expect(s.expectedInDay).toBe(1);
    expect(s.overrunning).toBe(false);
  });
});
