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

/** Source with comments stripped — the file explains these table names in prose. */
const SERVICE_SRC = readFileSync(
  join(__dirname, "..", "..", "src", "integrity", "retention", "integrity-retention.service.ts"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
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
    school: { findMany: jest.fn().mockResolvedValue([{ id: "s-1", integrityRetentionDays: 30 }]) },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
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
    const [r] = await svc.purgeAllSchools("SCHEDULED");
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

describe("the source itself", () => {
  it("purges these tables and no others", () => {
    // A coverage gate: adding a sixth stream of minors' telemetry without a
    // deleteMany here creates another table nothing can ever shrink, and nothing
    // at runtime would tell you — it just grows.
    const deleted = [...SERVICE_SRC.matchAll(/tx\.(\w+)\.deleteMany/g)].map((m) => m[1]);
    expect(deleted.sort()).toEqual([...PURGED].sort());
  });
});
