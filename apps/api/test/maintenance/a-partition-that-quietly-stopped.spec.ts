// =============================================================================
// The one condition this job exists to detect was the one it did not report
// =============================================================================
// `audit_log` is RANGE-partitioned by month, and a DEFAULT partition means an
// INSERT can never fail for want of one. That safety net is the whole risk: when
// a month goes un-provisioned nothing breaks, rows just pile into DEFAULT, and
// per the service's own comment they "must be migrated into a real partition
// before one can be added for their month" — which gets harder the longer nobody
// looks.
//
// The sweep detected it and logged at ERROR. But the OPERATOR'S JOBS CONSOLE
// derives its "Partial" badge from a numeric `failed` in the stored summary — an
// opt-in convention, so a job that reports none renders healthy for ever. This
// job reported none. `defaultRows` did appear in the summary text, beside every
// other green row, in the position used for ordinary chatter.
//
// This is the third instance of one lesson: the retention and dunning sweeps
// were given `failed` for exactly this reason ("a count nobody surfaces is a
// count nobody acts on") and this sibling was left as it was.
// =============================================================================

import { AuditPartitionProcessor } from "../../src/maintenance/audit-partition.processor";
import { AuditPartitionService } from "../../src/maintenance/audit-partition.service";

/**
 * `perTable` is the DEFAULT-partition count each partitioned table reports.
 * There is more than one now — `attendance_record` joined `audit_log` — and the
 * whole point of summing them is that a healthy table cannot hide a stalled
 * one, so the harness lets them differ.
 */
function makeService(perTable: number | Record<string, number>, ensured = ["audit_log_2026_08"]) {
  let call = 0;
  const rowsFor = (table: string) =>
    typeof perTable === "number" ? perTable : (perTable[table] ?? 0);
  const checked: string[] = [];
  const client = {
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      const ensureFn = sql.match(/SELECT (ensure_\w+)\(/)?.[1];
      if (ensureFn) {
        const name = ensured[Math.min(call++, ensured.length - 1)];
        return [{ [ensureFn]: name }];
      }
      const table = sql.match(/FROM "(\w+)_default"/)?.[1] ?? "";
      checked.push(table);
      return [{ count: BigInt(rowsFor(table)) }];
    }),
  };
  const svc = new AuditPartitionService({ client } as never);
  return Object.assign(svc, { __checked: checked }) as AuditPartitionService & { __checked: string[] };
}

describe("the audit partition sweep reports what an operator must act on", () => {
  it("reports `failed` so a run with rows in DEFAULT is flagged, not merely logged", async () => {
    const res = await makeService({ audit_log: 12 }).ensureUpcoming(0);
    expect(res.defaultRows).toBe(12);
    // The console's rule is `(lastFailed ?? 0) > 0`; null renders healthy.
    expect(res.failed).toBe(12);
  });

  it("checks EVERY partitioned table, not just the audit log", async () => {
    // `attendance_record` is the largest table in the product and its
    // partitions must exist before a register is taken — a school marks
    // attendance every working morning.
    const svc = makeService(0);
    await svc.ensureUpcoming(0);
    expect(svc.__checked.sort()).toEqual(["attendance_record", "audit_log"]);
  });

  it("a healthy table cannot hide a stalled one", async () => {
    // Summed, not reported per table: the console reads ONE number, so an
    // attendance month that was never created must raise it even while the
    // audit log is perfectly clean.
    const res = await makeService({ audit_log: 0, attendance_record: 7 }).ensureUpcoming(0);
    expect(res.failed).toBe(7);
  });

  it("a clean run reports zero, which is different from reporting nothing", async () => {
    const res = await makeService(0).ensureUpcoming(0);
    expect(res.failed).toBe(0);
    expect(res.defaultRows).toBe(0);
  });

  it("the PROCESSOR carries `failed` into the stored summary, which is what the console reads", async () => {
    // The seam that made the service fix insufficient on its own: what the
    // processor RETURNS is the stored summary, and it mapped the service result
    // field by field — dropping `failed` on the floor. A unit test on the
    // service alone would have gone green over a console that still showed the
    // row as healthy.
    const svc = makeService({ audit_log: 9 });
    const runs = { record: jest.fn(async (_k: string, _t: string, fn: () => Promise<unknown>) => fn()) };
    const proc = new AuditPartitionProcessor(svc as never, runs as never);
    const summary = await proc.process({ name: "audit-partition-ensure" } as never);
    // `ensured` is however many months the sweep provisions ahead — not pinned
    // here, because a test that hard-codes it breaks when the window changes and
    // teaches nothing. What must survive is the DEFAULT-partition count reaching
    // the summary under the name the console reads.
    expect({ defaultRows: summary.defaultRows, failed: summary.failed }).toEqual({
      defaultRows: 9,
      failed: 9,
    });
    expect(summary.ensured).toBeGreaterThan(0);
  });

  it("is a no-op with no privileged client, and still answers the console's protocol", async () => {
    // Disabled must not read as a partial failure: zero, not null, and not one.
    const res = await new AuditPartitionService({ client: null } as never).ensureUpcoming(0);
    expect([res.skipped, res.failed, res.defaultRows]).toEqual(["no-privileged-client", 0, 0]);
  });
});
