// =============================================================================
// The raw staff clock-scan stream had no purge path at all
// =============================================================================
// `staff_attendance_event` is append-only — INSERT and SELECT only for the app
// role, deliberately, so an amendment can never reach back and rewrite the scan
// it contradicts. That also means the privileged retention sweep is the ONLY
// thing in the platform that can ever make it smaller, and it was not in the
// sweep. Projected at 5,000 schools over five years it is the largest unmanaged
// table on the platform (~1.3B rows / ~305 GB), carried through every backup and
// every restore drill, while both of its siblings were handled: `scan_event` is
// purged on the school's privacy window and `attendance_record` is partitioned.
//
// THREE PROPERTIES DECIDE WHETHER PURGING IT IS SAFE, and each is a way this
// could have been built wrong while looking entirely reasonable:
//
// 1. The DAY ROW survives. `staff_attendance` is the employment record and is a
//    PROJECTION of these scans — first IN, last OUT. Purging the scans must
//    leave it untouched at any age, or a school loses its own attendance record
//    rather than the evidence behind it.
//
// 2. The WINDOW IS ITS OWN. `integrityRetentionDays` governs surveillance data
//    about children and a school setting it to ninety days is behaving well.
//    These scans are employment evidence about adults. Coupling them would let a
//    privacy-conservative decision silently destroy a school's lateness and
//    pay-dispute evidence — and neither window may gate the other in either
//    direction.
//
// 3. It is BATCHED. These windows are new, so the first sweep on a mature
//    database has years of rows to remove at once, on the biggest table there
//    is. Inside the telemetry transaction that is one enormous long-held delete
//    that rolls back on failure and retries the same delete for ever.
// =============================================================================

import { IntegrityRetentionService } from "../../src/integrity/retention/integrity-retention.service";

const sqlOf = (q: unknown): string => (Array.isArray(q) ? q.join(" ") : String(q ?? ""));

type SchoolRow = {
  id: string;
  integrityRetentionDays: number;
  staffAttendanceEventRetentionDays: number;
};

function makeService(schools: SchoolRow[], opts: { staffRows?: number } = {}) {
  // How many staff scans are past the window, drained in batches like the real
  // statement does — so a service that forgot to loop is visibly short.
  let remaining = opts.staffRows ?? 0;

  const del = jest.fn().mockResolvedValue({ count: 0 });
  const tx = {
    integritySignal: { deleteMany: del },
    submissionDraft: { deleteMany: del },
    submissionTelemetry: { deleteMany: del },
    xapiStatement: { deleteMany: del },
    scanEvent: { deleteMany: del },
    staffAttendance: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    integrityRetentionRun: { create: jest.fn().mockResolvedValue({}) },
  };
  const client = {
    school: { findMany: jest.fn().mockResolvedValue(schools) },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    gatewayEvent: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    notification: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $executeRaw: jest.fn((q: TemplateStringsArray, ...values: unknown[]) => {
      const sql = sqlOf(q);
      if (!/staff_attendance_event/.test(sql)) return Promise.resolve(0);
      // HONOURS THE LIMIT the statement asked for, and drains. A double that
      // returned a fixed count would report a batching service and a
      // one-shot one identically.
      const limit = Number(values[values.length - 1] ?? 0);
      const took = Math.min(remaining, limit);
      remaining -= took;
      return Promise.resolve(took);
    }),
  };
  const svc = new IntegrityRetentionService({ client } as never);
  return { svc, tx, client, staffLeft: () => remaining };
}

const school = (over: Partial<SchoolRow> = {}): SchoolRow => ({
  id: "s-1",
  integrityRetentionDays: 30,
  staffAttendanceEventRetentionDays: 730,
  ...over,
});

const staffCalls = (client: { $executeRaw: jest.Mock }) =>
  client.$executeRaw.mock.calls.filter((c) => /staff_attendance_event/.test(sqlOf(c[0])));

describe("the day row is the employment record and is never purged", () => {
  it("deletes from the EVENT table and never from the day row", async () => {
    const { svc, tx, client } = makeService([school()], { staffRows: 10 });
    await svc.purgeAllSchools("SCHEDULED");

    expect(staffCalls(client)).not.toHaveLength(0);
    // Not one statement anywhere in the sweep touches `staff_attendance`.
    expect(tx.staffAttendance.deleteMany).not.toHaveBeenCalled();
    const everySql = client.$executeRaw.mock.calls.map((c) => sqlOf(c[0])).join("\n");
    expect(everySql).not.toMatch(/DELETE FROM staff_attendance\b/);
  });

  it("bounds the delete by schoolId AND by the school's calendar day", async () => {
    // The privileged client bypasses RLS, so the predicate carries the tenant
    // boundary itself — a missing schoolId here purges the whole fleet.
    //
    // `date` is a @db.Date holding the SCHOOL's day, not an instant, so the
    // cutoff has to be a day too: comparing a day column against a mid-afternoon
    // timestamp would take half of the boundary day with it.
    const { svc, client } = makeService([school()], { staffRows: 5 });
    await svc.purgeAllSchools("SCHEDULED");

    const [tag, ...values] = staffCalls(client)[0] as [TemplateStringsArray, ...unknown[]];
    const sql = sqlOf(tag);
    expect(sql).toMatch(/"schoolId" =/);
    expect(sql).toMatch(/"date" </);

    const cutoff = values.find((v): v is Date => v instanceof Date);
    expect(cutoff).toBeInstanceOf(Date);
    // Midnight: a whole day either side of the boundary, never a part of one.
    expect([cutoff!.getUTCHours(), cutoff!.getUTCMinutes(), cutoff!.getUTCSeconds(), cutoff!.getUTCMilliseconds()])
      .toEqual([0, 0, 0, 0]);
    // And it is the STAFF window, not the telemetry one — 730 days, not 30.
    const days = Math.round((Date.now() - cutoff!.getTime()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(729);
  });
});

describe("the two windows are independent in BOTH directions", () => {
  it("purges staff scans for a school that has DISABLED telemetry purging", async () => {
    // The defect this exists for. Running the staff purge inside the telemetry
    // window's early return meant a school choosing not to purge observations of
    // its pupils — a privacy-conservative choice, and the reason the dial exists
    // — silently stopped purging its staff scans too, and the largest table on
    // the platform grew for ever with nothing said.
    const { svc, client } = makeService(
      [school({ integrityRetentionDays: 0, staffAttendanceEventRetentionDays: 730 })],
      { staffRows: 10 },
    );
    const [r] = (await svc.purgeAllSchools("SCHEDULED")).schools;

    expect(staffCalls(client)).not.toHaveLength(0);
    expect(r.staffEventsDeleted).toBe(10);
    // And it says WHICH half did nothing, rather than one flag reading as
    // "this school was skipped" when half of it was swept.
    expect(r.skipped).toBe("DISABLED");
    expect(r.staffEventsSkipped).toBeUndefined();
  });

  it("purges telemetry for a school that has DISABLED staff-scan purging", async () => {
    const { svc, tx, client } = makeService(
      [school({ integrityRetentionDays: 30, staffAttendanceEventRetentionDays: 0 })],
      { staffRows: 10 },
    );
    const [r] = (await svc.purgeAllSchools("SCHEDULED")).schools;

    expect(staffCalls(client)).toHaveLength(0);
    expect(tx.integritySignal.deleteMany).toHaveBeenCalled();
    expect(r.staffEventsSkipped).toBe("DISABLED");
    expect(r.skipped).toBeUndefined();
  });

  it("records the window it APPLIED, and null when it applied none", async () => {
    // The run record is the interpretable history: `retentionDays` is snapshot
    // for exactly this reason. A window of 0 and no window at all are different
    // facts, and a run from before this stream existed applied no window.
    const on = makeService([school()], { staffRows: 3 });
    await on.svc.purgeAllSchools("SCHEDULED");
    expect(on.tx.integrityRetentionRun.create.mock.calls[0][0].data).toMatchObject({
      staffEventsDeleted: 3,
      staffEventRetentionDays: 730,
    });

    const off = makeService([school({ staffAttendanceEventRetentionDays: 0 })], { staffRows: 3 });
    await off.svc.purgeAllSchools("SCHEDULED");
    expect(off.tx.integrityRetentionRun.create.mock.calls[0][0].data).toMatchObject({
      staffEventsDeleted: 0,
      staffEventRetentionDays: null,
    });
  });
});

describe("it is batched, and the sweep's total includes it", () => {
  it("keeps deleting until the backlog is drained, rather than one statement", async () => {
    // 45,000 rows past the window against a 20,000-row batch: a service that
    // issued one statement removes 20,000 and reports success while 25,000
    // remain, every night, for ever.
    const { svc, client, staffLeft } = makeService([school()], { staffRows: 45_000 });
    const [r] = (await svc.purgeAllSchools("SCHEDULED")).schools;

    expect(staffCalls(client).length).toBeGreaterThan(1);
    expect(r.staffEventsDeleted).toBe(45_000);
    expect(staffLeft()).toBe(0);
  });

  it("purges OUTSIDE the telemetry transaction, so the batches auto-commit", async () => {
    // Inside it, the first sweep on a mature database is one enormous long-held
    // delete: locks, a WAL burst, and a rollback that retries the same delete
    // the next night for ever. Asserted by ORDER — every staff statement runs
    // before the transaction opens.
    const order: string[] = [];
    const { svc, client } = makeService([school()], { staffRows: 30_000 });
    client.$executeRaw.mockImplementation((q: TemplateStringsArray) => {
      if (/staff_attendance_event/.test(sqlOf(q))) {
        order.push("staff");
        return Promise.resolve(order.filter((o) => o === "staff").length === 1 ? 20_000 : 10_000);
      }
      return Promise.resolve(0);
    });
    client.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => {
      order.push("tx");
      return fn({
        integritySignal: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        submissionDraft: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        submissionTelemetry: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        xapiStatement: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        scanEvent: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        integrityRetentionRun: { create: jest.fn().mockResolvedValue({}) },
      });
    });

    await svc.purgeAllSchools("SCHEDULED");
    expect(order.indexOf("tx")).toBe(order.lastIndexOf("staff") + 1);
  });

  it("counts staff scans in the SWEEP'S OWN total, which is what an operator reads", async () => {
    // The largest stream by a wide margin. Omitting it from the total is how
    // this same figure once under-reported millions — and a night that removed
    // most of a terabyte would read as a night that found nothing.
    const { svc } = makeService([school()], { staffRows: 1_234 });
    const result = await svc.purgeAllSchools("SCHEDULED");
    expect(result.purged).toBe(1_234);
  });
});
