// =============================================================================
// Reading your own write, when the read comes from somewhere else
// =============================================================================
// 103 read paths route to `DATABASE_REPLICA_URL` when one is set, and Terraform
// already provisions replicas and wires that variable into ECS. Nothing checked
// whether the replica had caught up. Against a real streaming standby with
// replay paused:
//
//   teacher POSTs a leave request      201, committed on the primary
//   teacher GETs their own approvals   0 rows — their request is not there
//
// From the applicant's side the system lost their application, and the natural
// next action is to submit it again.
//
// WHY LSN AND NOT A TIMER. "Primary for N seconds after a write" is the usual
// shortcut and it is wrong in both directions: too weak, because a standby can
// lag for minutes; too strong, because it forfeits the replica for N seconds
// when the standby caught up in 20 ms. A write records the primary's WAL
// position and a read compares it with the standby's replay position, which is
// the actual question.
// =============================================================================

import { lsnToBigInt, ReplicaRouterService, READ_AFTER_WRITE_WINDOW_SECONDS } from "../../src/foundation/replica-router.service";

/** A router with no Redis, driven directly — the single-instance fallback path. */
function makeRouter(opts: { configured?: boolean; replayLsn?: string | null; degraded?: boolean } = {}) {
  const r = Object.create(ReplicaRouterService.prototype) as ReplicaRouterService;
  Object.assign(r, {
    configured: opts.configured ?? true,
    redis: null,
    local: new Map(),
    replayLsn: opts.replayLsn === undefined ? lsnToBigInt("3/B5000060") : opts.replayLsn === null ? null : lsnToBigInt(opts.replayLsn),
    lagSeconds: 0,
    degraded: opts.degraded ?? false,
    observer: null,
    logger: { log: jest.fn(), warn: jest.fn() },
  });
  return r;
}

describe("comparing WAL positions", () => {
  it("orders two positions in the same segment", () => {
    expect(lsnToBigInt("3/B5000060") > lsnToBigInt("3/B5000059")).toBe(true);
  });

  it("orders across a segment boundary, where a string compare would not", () => {
    // "3/FF" vs "4/00": lexicographically the first is larger, numerically it is
    // not. Getting this backwards releases a user to a standby that is behind.
    expect(lsnToBigInt("4/00000000") > lsnToBigInt("3/FFFFFFFF")).toBe(true);
  });

  it("keeps precision past 2^53, where Number would not", () => {
    // The low half alone reaches 2^32 and the combined value passes what a
    // double can represent exactly. Two positions 1 byte apart must not compare
    // equal — that is a stale read, silently.
    const a = lsnToBigInt("FFFFFFFF/FFFFFFFE");
    const b = lsnToBigInt("FFFFFFFF/FFFFFFFF");
    expect(a < b).toBe(true);
    expect(Number(a) < Number(b)).toBe(false); // the bug this avoids
  });
});

describe("which database serves a read", () => {
  it("the primary when no replica is configured", async () => {
    const r = makeRouter({ configured: false });
    await expect(r.useReplica("u1")).resolves.toMatchObject({ replica: false });
  });

  it("the replica when the user has written nothing", async () => {
    const r = makeRouter();
    await expect(r.useReplica("u1")).resolves.toMatchObject({ replica: true });
  });

  it("the PRIMARY when the standby has not replayed this user's write", async () => {
    const r = makeRouter({ replayLsn: "3/B5000060" });
    await r.noteWrite("u1", "3/B5000099");
    await expect(r.useReplica("u1")).resolves.toMatchObject({ replica: false });
  });

  it("the replica again once the standby passes that position", async () => {
    // The release is the point: a timer would hold this user on the primary for
    // its whole window even though the standby caught up immediately.
    const r = makeRouter({ replayLsn: "3/B5000099" });
    await r.noteWrite("u1", "3/B5000099");
    await expect(r.useReplica("u1")).resolves.toMatchObject({ replica: true });
  });

  it("holds only the user who wrote, not everybody else", async () => {
    // Session consistency. Routing a whole school to the primary because one
    // person is typing would undo the read/write split.
    const r = makeRouter({ replayLsn: "3/B5000060" });
    await r.noteWrite("u1", "3/B5000099");
    await expect(r.useReplica("u2")).resolves.toMatchObject({ replica: true });
  });

  it("the PRIMARY for everybody when the replica is lagging", async () => {
    const r = makeRouter({ degraded: true });
    await expect(r.useReplica("u2")).resolves.toMatchObject({ replica: false, reason: "replica lagging" });
  });

  it("the PRIMARY when the standby's position is unknown", async () => {
    // Unreachable, or not yet sampled. A write is outstanding and nothing can
    // say whether it has arrived, so the only safe answer is the primary.
    const r = makeRouter({ replayLsn: null });
    await r.noteWrite("u1", "3/B5000099");
    await expect(r.useReplica("u1")).resolves.toMatchObject({ replica: false });
  });

  it("forgets a write once the window has passed", async () => {
    // The backstop: a standby that never catches up must not pin every user who
    // ever wrote to the primary for ever.
    const r = makeRouter({ replayLsn: "3/B5000060" });
    await r.noteWrite("u1", "3/B5000099");
    const local = (r as unknown as { local: Map<string, { lsn: bigint; at: number }> }).local;
    local.set("u1", { lsn: lsnToBigInt("3/B5000099"), at: Date.now() - (READ_AFTER_WRITE_WINDOW_SECONDS + 1) * 1000 });
    await expect(r.useReplica("u1")).resolves.toMatchObject({ replica: true });
  });

  it("records nothing at all when no replica is configured", async () => {
    // The bookkeeping costs a round trip; a single-database deployment must not
    // pay it.
    const r = makeRouter({ configured: false });
    await r.noteWrite("u1", "3/B5000099");
    expect((r as unknown as { local: Map<string, unknown> }).local.size).toBe(0);
  });

  it("reports the reason, so /metrics can say WHY reads moved", async () => {
    const seen: string[] = [];
    const r = makeRouter({ degraded: true });
    r.setObserver(({ reason }) => seen.push(reason));
    await r.useReplica("u1");
    expect(seen).toEqual(["replica lagging"]);
  });
});

// ---------------------------------------------------------------------------

import { MetricsService } from "../../src/observability/metrics.service";

describe("what an operator can see", () => {
  // Handling stale reads silently is only half the job. If reads move to the
  // primary and nobody can tell, the first symptom is the primary's CPU and
  // nobody connects the two.
  it("publishes lag and where each read went, with the reason", async () => {
    const m = new MetricsService();
    m.observeReadRouting(true, "replica lagging", 12.5);
    m.observeReadRouting(false, "no recent write", 0);
    const text = await m.render();
    expect(text).toMatch(/db_replica_lag_seconds 0/);
    expect(text).toMatch(/db_reads_routed_total\{target="primary",reason="replica lagging"\} 1/);
    expect(text).toMatch(/db_reads_routed_total\{target="replica",reason="no recent write"\} 1/);
  });

  it("raises the degraded gauge only for lag, not for a user's own write", async () => {
    // Being sent to the primary because YOU just wrote is the system working.
    // Being sent because the replica is behind is the system coping. An alert
    // that cannot tell them apart fires every time anybody saves anything.
    const m = new MetricsService();
    m.observeReadRouting(true, "replica has not replayed this user's write", 0);
    expect(await m.render()).toMatch(/db_replica_degraded 0/);
    m.observeReadRouting(true, "replica lagging", 30);
    expect(await m.render()).toMatch(/db_replica_degraded 1/);
  });
});
