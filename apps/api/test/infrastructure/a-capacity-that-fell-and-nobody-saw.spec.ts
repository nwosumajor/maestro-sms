// =============================================================================
// A capacity that fell by 3.5x and nobody saw
// =============================================================================
// The API served 770 req/s in July and 216 in September on the same harness.
// No single change did it — a key rebuilt on every token verification, a grant
// read on every request, a duplicated round trip — and nobody ran the harness,
// so nobody saw the trend. `capacity-trend.mjs` is the judge the scheduled
// capacity workflow runs on each result. These drive the REAL script, the way
// the workflow does, against a temp history.
// =============================================================================

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "../../scripts/capacity-trend.mjs");
const CONFIG = { mode: "overhead", schools: 20, users: 5, students: 0, writePct: 0, concurrency: 50, duration: 30 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "capacity-trend-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const result = (rps: number, extra: Record<string, unknown> = {}) => ({
  at: "2026-09-26T00:00:00Z",
  config: CONFIG,
  rps,
  total: rps * 30,
  errorPct: 0,
  peakConns: 10,
  endpoints: [{ key: "students", n: 100, errPct: 0, p50: 10, p95: 20, p99: 30 }],
  ...extra,
});

function judge(r: object, opts: { accept?: boolean } = {}) {
  const rp = join(dir, "r.json");
  writeFileSync(rp, JSON.stringify(r));
  const out = spawnSync(
    process.execPath,
    [SCRIPT, "--result", rp, "--history", join(dir, "h.jsonl"), ...(opts.accept ? ["--accept"] : [])],
    { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
  );
  return { code: out.status, out: out.stdout + out.stderr };
}
const history = () =>
  existsSync(join(dir, "h.jsonl"))
    ? readFileSync(join(dir, "h.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const seed = (...rps: number[]) => {
  for (const r of rps) expect(judge(result(r)).code).toBe(0);
};

describe("capacity-trend", () => {
  it("has no bar until three comparable runs exist — one runner is not a standard", () => {
    const first = judge(result(400));
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/BASELINE 1\/3/);
    expect(judge(result(50)).code).toBe(0); // no bar yet: nothing to fall below
    expect(history()).toHaveLength(2);
  });

  it("passes a run within 20% of the median of recent runs, and records it", () => {
    seed(400, 410, 390);
    expect(judge(result(330)).code).toBe(0);
    expect(history()).toHaveLength(4);
  });

  it("FAILS a drop of more than 20%, and does NOT record it", () => {
    seed(400, 410, 390);
    const r = judge(result(300));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/below the median/);
    expect(history().map((h) => h.rps)).toEqual([400, 410, 390]);
  });

  it("FAILS a run that errored, even with no bar yet", () => {
    const r = judge(result(400, { errorPct: 5 }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/requests failed/);
  });

  it("compares only runs of the SAME config", () => {
    for (const r of [1000, 1000, 1000]) judge(result(r, { config: { ...CONFIG, schools: 5000 } }));
    const r = judge(result(400));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/BASELINE 1\/3/);
  });

  it("catches a decline that passes one step at a time", () => {
    // Each step is inside 20% of the rolling median, and the window follows it
    // down. The cumulative check against the best rolling median must stop it.
    seed(400, 400, 400);
    const steps = [340, 340, 340, 340, 290, 290, 290, 250, 250, 250];
    let stoppedAt: number | undefined;
    for (const s of steps) {
      if (judge(result(s)).code !== 0) {
        stoppedAt = s;
        break;
      }
    }
    expect(stoppedAt).toBeDefined();
    expect(stoppedAt!).toBeGreaterThanOrEqual(250);
    expect(stoppedAt!).toBeLessThan(400 * 0.7 + 1);
  });

  it("--accept makes a slower level the new normal: recorded with a rebaseline, and the bar restarts", () => {
    seed(400, 410, 390);
    const r = judge(result(300), { accept: true });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/ACCEPTED as the new normal/);
    const h = history();
    expect(h[h.length - 2]).toMatchObject({ rebaseline: true });
    expect(h[h.length - 1]).toMatchObject({ rps: 300 });
    // After the rebaseline there is no bar again until three runs exist.
    expect(judge(result(290)).out).toMatch(/BASELINE 2\/3/);
  });
});
