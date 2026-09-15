import { Logger } from "@nestjs/common";
import { stripComments } from "../support/strip-comments";
// =============================================================================
// Retention covers EVERY stream of telemetry about children
// =============================================================================
// The sweep purged three tables and left two growing for ever: `xapi_statement`
// (every learning interaction — xAPI is firehose-shaped by design) and
// `scan_event` (every gate, library and exam-hall check-in).
//
// Both are behavioural telemetry about minors, which Golden Rule #5 names
// explicitly, and the app role is INSERT/SELECT only on both — so this sweep is
// the ONLY thing that can ever make them smaller. Left as they were, the two
// highest-volume tables in the system would have been the two nobody ever
// deleted from.
//
// One window governs all five, deliberately: a school that has decided how long
// it keeps observations of its pupils has decided it for all of them, and
// separate dials would only ever drift apart.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IntegrityRetentionService } from "../../src/integrity/retention/integrity-retention.service";
import { IntegrityRetentionProcessor } from "../../src/integrity/retention/integrity-retention.processor";
import { PURGE_EXPIRED_JOB } from "../../src/integrity/integrity.constants";

/** The job-run recorder, stubbed: it runs the work and records nothing. These
 *  suites are about what a sweep REPORTS, not about its run history. */
const norecord = { record: <T,>(_j: string, _t: string, fn: () => Promise<T>) => fn() } as never;


/** Source with comments stripped — the file explains these table names in prose. */
const SERVICE_SRC = stripComments(readFileSync(
  join(__dirname, "..", "..", "src", "integrity", "retention", "integrity-retention.service.ts"),
  "utf8",
))
  
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

/** Every table the sweep must clear, and nothing else. */
const PURGED = [
  "integritySignal",
  "submissionDraft",
  "submissionTelemetry",
  "xapiStatement",
  "scanEvent",
];

/**
 * The SQL of a `$executeRaw` call.
 *
 * `client.$executeRaw` is a TAGGED TEMPLATE, so the first argument is the
 * TemplateStringsArray itself — not an object with a `strings` property. A
 * double that reads `q.strings` gets `undefined` for every call, matches
 * nothing, and answers every statement with the same value: it then vouches for
 * any raw query standing in for any other. (Written that way first, which is how
 * this comment comes to be here.)
 */
const sqlOf = (q: unknown): string => (Array.isArray(q) ? q.join(" ") : String(q ?? ""));

function makeService(counts: Record<string, number>) {
  const del = (k: string) => jest.fn().mockResolvedValue({ count: counts[k] ?? 0 });
  const tx = {
    integritySignal: { deleteMany: del("integritySignal") },
    submissionDraft: { deleteMany: del("submissionDraft") },
    submissionTelemetry: { deleteMany: del("submissionTelemetry") },
    xapiStatement: { deleteMany: del("xapiStatement") },
    scanEvent: { deleteMany: del("scanEvent") },
    integrityRetentionRun: { create: jest.fn().mockResolvedValue({}) },
  };
  const client = {
    school: {
      findMany: jest.fn().mockResolvedValue([
        // BOTH windows, because the sweep now reads both. A fixture that omitted
        // the staff one would leave that whole stream disabled and every
        // assertion below would be made against a sweep doing less than the real
        // one does — the fixture trap this repo keeps recording.
        { id: "s-1", integrityRetentionDays: 30, staffAttendanceEventRetentionDays: 730 },
      ]),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    // The two PLATFORM-WIDE streams, swept once per run rather than per school.
    gatewayEvent: { deleteMany: jest.fn().mockResolvedValue({ count: counts.gatewayEvent ?? 0 }) },
    // The platform-wide purge also clears READ notifications (see the
    // unbounded-growers suite); unread are never touched at any age.
    notification: { deleteMany: jest.fn().mockResolvedValue({ count: counts.notification ?? 0 }) },
    // ANSWERS BY WHAT WAS ASKED. Several different raw statements go through
    // here now — the per-school staff-scan purge and the platform-wide ones —
    // and one blanket return value would let any of them stand in for another.
    $executeRaw: jest.fn((q: TemplateStringsArray) => {
      const sql = sqlOf(q);
      if (/staff_attendance_event/.test(sql)) return Promise.resolve(counts.staffAttendanceEvent ?? 0);
      if (/lms_content_revision/.test(sql)) return Promise.resolve(counts.lmsContentRevision ?? 0);
      return Promise.resolve(0);
    }),
  };
  const db = { client };
  const svc = new IntegrityRetentionService(db as never);
  return { svc, tx, client };
}

describe("the sweep clears every telemetry stream", () => {
  it("deletes from all five tables in ONE transaction", async () => {
    const { svc, tx, client } = makeService({});
    await svc.purgeAllSchools("SCHEDULED");
    for (const table of PURGED) {
      expect({ table, called: (tx as never as Record<string, { deleteMany: jest.Mock }>)[table].deleteMany.mock.calls.length })
        .toEqual({ table, called: 1 });
    }
    // One transaction, so a partial purge cannot leave a school half-retained.
    expect(client.$transaction).toHaveBeenCalledTimes(1);
  });

  it("bounds EVERY delete by schoolId and by that table's OWN age column", async () => {
    // The retention client is privileged and bypasses RLS, so each delete carries
    // its own tenant boundary — a missing schoolId here purges every school.
    //
    // The age column is asserted PER TABLE because they differ: an xAPI statement
    // records when it was STORED, not created. A mock accepts any `where`, so the
    // first version of this test asserted `createdAt` for all five and passed
    // while the real query was invalid — the DB-backed e2e is what caught it.
    const AGE_COLUMN: Record<string, string> = {
      integritySignal: "createdAt",
      submissionDraft: "createdAt",
      submissionTelemetry: "createdAt",
      xapiStatement: "storedAt",
      scanEvent: "createdAt",
    };
    const { svc, tx } = makeService({});
    await svc.purgeAllSchools("SCHEDULED");
    for (const table of PURGED) {
      const where = (tx as never as Record<string, { deleteMany: jest.Mock }>)[table].deleteMany.mock.calls[0][0].where;
      const col = AGE_COLUMN[table];
      expect({ table, schoolId: where.schoolId, column: col, bounded: where[col]?.lt instanceof Date })
        .toEqual({ table, schoolId: "s-1", column: col, bounded: true });
    }
  });

  it("records what it deleted, per stream", async () => {
    const { svc, tx } = makeService({ integritySignal: 3, xapiStatement: 11, scanEvent: 7 });
    await svc.purgeAllSchools("SCHEDULED");
    expect(tx.integrityRetentionRun.create.mock.calls[0][0].data).toMatchObject({
      signalsDeleted: 3,
      xapiDeleted: 11,
      scansDeleted: 7,
    });
  });

  it("returns the new counts per school", async () => {
    const { svc } = makeService({ xapiStatement: 50, scanEvent: 40 });
    const [r] = (await svc.purgeAllSchools("SCHEDULED")).schools;
    expect({ xapi: r.xapiDeleted, scans: r.scansDeleted }).toEqual({ xapi: 50, scans: 40 });
  });

  it("counts the NEW streams in the SWEEP'S OWN reported total", async () => {
    // Asserted on the figure the SERVICE computes, not on one this test adds up
    // itself. Summing the fields here would pass even with the service's total
    // left unchanged — which it did, until this test read the real number.
    //
    // It matters because that total is the one line an operator reads. Omitting
    // the two largest tables would under-report by most of the work, and read as
    // reassuring precisely when it should not.
    const { svc } = makeService({
      integritySignal: 1, submissionDraft: 1, submissionTelemetry: 1, xapiStatement: 50, scanEvent: 40,
    });
    const logged: string[] = [];
    jest
      .spyOn((svc as unknown as { logger: { log: (m: string) => void } }).logger, "log")
      .mockImplementation((m: string) => void logged.push(m));

    await svc.purgeAllSchools("SCHEDULED");
    const summary = logged.find((l) => l.includes("rows purged"));
    expect(summary).toBeDefined();
    expect(summary).toContain("93 rows purged");
  });
});

describe("the platform-wide streams — not about pupils, still unbounded", () => {
  it("purges gateway events on receivedAt ALONE, so orphans go too", async () => {
    // gateway_event.schoolId is NULLABLE by documented design: a webhook can
    // arrive before we know whose it is. Scoping the delete by schoolId would
    // leave every unmatched event behind for ever — exactly the set that
    // accumulates. So this one delete is deliberately not tenant-bounded.
    const { svc, client } = makeService({});
    await svc.purgeAllSchools("SCHEDULED");
    const where = (client.gatewayEvent.deleteMany as jest.Mock).mock.calls[0][0].where;
    expect(Object.keys(where)).toEqual(["receivedAt"]);
    expect(where.receivedAt.lt).toBeInstanceOf(Date);
    // Two years: past the ~540-day window a card scheme allows for a chargeback,
    // because the first question in a dispute is what the gateway told us.
    const days = Math.round((Date.now() - where.receivedAt.lt.getTime()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(540);
  });

  it("caps content revisions PER ITEM, not by age", async () => {
    // Age is the wrong bound both ways: a lesson untouched for three years would
    // lose its only history, while a lesson edited two hundred times this month —
    // the real growth risk — would lose nothing.
    const { svc, client } = makeService({});
    await svc.purgeAllSchools("SCHEDULED");
    // By what it IS, not by its position: the staff-scan purge now runs before
    // the platform-wide statements, so `calls[0]` is a different query.
    const sql = (client.$executeRaw as jest.Mock).mock.calls
      .map((c) => sqlOf(c[0]))
      .find((q) => /lms_content_revision/.test(q)) ?? "";
    expect(sql).toContain("lms_content_revision");
    expect(sql).toContain("PARTITION BY");
    expect(sql).toContain("contentId");
    expect(sql).not.toMatch(/createdAt|storedAt/);
  });

  it("runs them ONCE per sweep, not once per school", async () => {
    // Per-school would delete the same platform-wide rows N times over and report
    // a wildly inflated count.
    // Counted over the PLATFORM-WIDE statements only. The staff-scan purge is
    // deliberately per school — it is tenant data — so counting every raw
    // statement would now conflate the two and this test would be asserting the
    // opposite of its own name.
    const platformWideRawCalls = (c: { $executeRaw: jest.Mock }) =>
      c.$executeRaw.mock.calls.filter((call) => !/staff_attendance_event/.test(sqlOf(call[0]))).length;

    const { svc, client } = makeService({});
    (client.school.findMany as jest.Mock).mockResolvedValue([
      { id: "s-1", integrityRetentionDays: 30, staffAttendanceEventRetentionDays: 730 },
      { id: "s-2", integrityRetentionDays: 30, staffAttendanceEventRetentionDays: 730 },
      { id: "s-3", integrityRetentionDays: 30, staffAttendanceEventRetentionDays: 730 },
    ]);
    await svc.purgeAllSchools("SCHEDULED");
    // THREE schools, but each platform-wide statement runs ONCE. Asserting a
    // fixed count of raw statements would break every time one is added and say
    // nothing about the property; what matters is that the count does not scale
    // with the number of schools.
    const rawCallsFor3 = platformWideRawCalls(client as never);
    expect(client.gatewayEvent.deleteMany).toHaveBeenCalledTimes(1);

    const second = makeService({});
    (second.client.school.findMany as jest.Mock).mockResolvedValue([
      { id: "only-1", integrityRetentionDays: 30, staffAttendanceEventRetentionDays: 730 },
    ]);
    await second.svc.purgeAllSchools("SCHEDULED");
    expect(platformWideRawCalls(second.client as never)).toBe(rawCallsFor3);
  });

  it("keeps them OUT of the per-school run record", async () => {
    // That record is per school; attributing a platform-wide delete to one
    // school would misrepresent what happened.
    //
    // Asserted on the FIELDS, not by scanning the serialised row for the number.
    // The first version did `expect(JSON.stringify(data)).not.toContain("99")`
    // and failed on a day whose timestamp happened to read `…45.990Z` — the same
    // coincidental-substring trap as matching a secret against a UUID, made by
    // the same hand that had just fixed it.
    const { svc, tx } = makeService({ gatewayEvent: 99, lmsContentRevision: 99 });
    await svc.purgeAllSchools("SCHEDULED");
    const data = tx.integrityRetentionRun.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(Object.keys(data)).not.toContain("gatewayEventsDeleted");
    expect(Object.keys(data)).not.toContain("contentRevisionsDeleted");
    // And every count it DOES record is a per-school one, all zero here.
    expect(data).toMatchObject({ signalsDeleted: 0, draftsDeleted: 0, telemetryDeleted: 0, xapiDeleted: 0, scansDeleted: 0 });
  });
});

describe("the source itself", () => {
  it("purges these tables and no others", () => {
    // A coverage gate: adding a sixth stream of minors' telemetry without a
    // deleteMany here creates another table nothing can ever shrink, and nothing
    // at runtime would tell you — it just grows.
    const deleted = [...SERVICE_SRC.matchAll(/tx\.(\w+)\.deleteMany/g)].map((m) => m[1]);
    expect(deleted.sort()).toEqual([...PURGED].sort());
  });

  it("sweeps the per-school streams written as RAW SQL too", () => {
    // The gate above scans for `tx.X.deleteMany`, so a stream purged with raw
    // SQL is INVISIBLE to it. `staff_attendance_event` is exactly that — it is
    // batched, so it cannot ride inside the telemetry transaction — and it is
    // the largest table the platform projects. A coverage gate that cannot see
    // the biggest stream it is meant to cover is worse than no gate, because it
    // reports the set as complete.
    expect(SERVICE_SRC).toMatch(/DELETE FROM staff_attendance_event/);
    // Tenant-bounded, on the privileged RLS-bypassing client.
    expect(SERVICE_SRC).toMatch(/staff_attendance_event[\s\S]{0,400}?"schoolId" = \$\{schoolId\}/);
  });
});

// ===========================================================================
// The JOB RESULT — the number that outlives the log line
// ===========================================================================
// The service's own total was already correct and tested. The BullMQ processor
// re-derived it and summed THREE of the five tenant streams, omitting
// xapiDeleted and scansDeleted (scan_event is one of the largest tables the
// platform projects) and every platform-wide stream. A night that removed
// millions could store `purged: 0` as the job's result — and unlike a log line
// that is what a dashboard or an on-call check reads back later.
//
// The durable fix was to stop DERIVING the total in more than one place, so
// these cases assert the processor reports what the service computed.
describe("IntegrityRetentionProcessor job result", () => {
  const job = { name: PURGE_EXPIRED_JOB } as never;

  it("reports the total the SERVICE computed, never one of its own", async () => {
    const counts = {
      integritySignal: 1, submissionDraft: 2, submissionTelemetry: 3,
      xapiStatement: 50, scanEvent: 40,          // the two that were dropped
      gatewayEvent: 7, lmsContentRevision: 5,
    };
    // The service's own figure, taken from the service — NOT re-added here. A
    // test that summed the fields itself would agree with a wrong processor
    // just as readily as a right one.
    const expected = (await makeService(counts).svc.purgeAllSchools("SCHEDULED")).purged;
    const out = await new IntegrityRetentionProcessor(makeService(counts).svc, norecord).process(job);
    expect(out).toEqual({ schools: 1, purged: expected, failed: 0 });
  });

  // The sharp case: a night whose ENTIRE yield is the two streams the old
  // processor dropped. It reported 0 — indistinguishable from a quiet night.
  it("a sweep of ONLY xapi + scan events does not report zero", async () => {
    const { svc } = makeService({ xapiStatement: 50, scanEvent: 40 });
    const out = await new IntegrityRetentionProcessor(svc, norecord).process(job);
    expect(out.purged).toBe(90);
  });

  it("carries `failed` through, so a school it could not purge reaches the console", async () => {
    // The service counts a school whose purge threw and carries on, which is
    // right — one school's failure must not end the fleet's sweep. But a catch
    // that does not rethrow leaves `lastOk` true, so the job summary's `failed`
    // field is the operator console's ONLY sight of it. The processor dropped it
    // between the service and `record()`: the sweep counted four skipped schools
    // and nothing anybody reads was ever told, every night, looking healthy.
    //
    // Minors' telemetry sitting past its retention window is the one outcome
    // this job exists to prevent.
    const { svc, client } = makeService({});
    (client.school.findMany as jest.Mock).mockResolvedValue([
      { id: "ok-1", integrityRetentionDays: 30, staffAttendanceEventRetentionDays: 730 },
      { id: "bad", integrityRetentionDays: 30, staffAttendanceEventRetentionDays: 730 },
    ]);
    (client.$transaction as jest.Mock).mockImplementationOnce(async () => {
      throw new Error("deadlock detected");
    });

    const out = await new IntegrityRetentionProcessor(svc, norecord).process(job);
    expect(out.failed).toBe(1);
    // And it is the SERVICE's count, not a second one derived here.
    expect(out.schools).toBe(1);
  });

  it("a sweep with NO privileged DB is not a sweep that found nothing", async () => {
    const svc = new IntegrityRetentionService({ client: null } as never);
    const processor = new IntegrityRetentionProcessor(svc, norecord);
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => { logged.push(String(m)); });
    try {
      await expect(processor.process(job)).resolves.toEqual({ schools: 0, purged: 0, failed: 0 });
      expect(logged.join(" ")).toMatch(/SKIPPED/i);
    } finally {
      jest.restoreAllMocks();
    }
  });
});
