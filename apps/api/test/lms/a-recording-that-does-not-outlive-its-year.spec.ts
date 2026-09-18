// =============================================================================
// A recorded lesson does not outlive the year it was taught in
// =============================================================================
// Footage of named children, kept for no stated purpose, is the thing this
// sweep exists to prevent — and the storage bill growing with the school's
// LIFETIME is the shape this codebase records as the one that degrades
// invisibly. Each recording is dated when it is attached; this removes the
// bytes afterwards and leaves the row saying so.
//
// THE CAP MUST ADVANCE. Clearing `recordingKey` is what takes a row out of the
// predicate the page is drawn from, so run two reaches what run one capped out
// of. The declined-applicant purge had exactly this shape and did NOT advance,
// for as long as it existed — that is the defect this test is shaped against.
// =============================================================================

import { RecordingRetentionService } from "../../src/lms/recording-retention.service";
import { RECORDING_RETENTION_BATCH } from "../../src/lms/recording-retention.constants";

type Row = { id: string; schoolId: string; recordingKey: string | null; recordingSizeBytes: number | null; recordingExpiresAt: Date | null };

function harness(rows: Row[], opts: { refuse?: (key: string) => boolean; noDb?: boolean } = {}) {
  const store = [...rows];
  const deleted: string[] = [];
  /** The rows the real query selects: still HOLDING bytes, and past their date.
   *  Modelled as the join it is, and capped with the service's OWN constant — a
   *  double that ignores the cap cannot see the defect the cap causes. */
  const due = (onlySchoolId?: string) =>
    store.filter(
      (r) =>
        r.recordingKey !== null &&
        r.recordingExpiresAt !== null &&
        r.recordingExpiresAt < new Date() &&
        (!onlySchoolId || r.schoolId === onlySchoolId),
    );

  const client = {
    lmsLiveSession: {
      findMany: jest.fn(async ({ where, take }: { where: { schoolId?: string }; take?: number }) => {
        const list = due(where?.schoolId).sort(
          (a, b) => (a.recordingExpiresAt!.getTime() - b.recordingExpiresAt!.getTime()),
        );
        return typeof take === "number" ? list.slice(0, take) : list;
      }),
      count: jest.fn(async ({ where }: { where: { schoolId?: string } }) => due(where?.schoolId).length),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = store.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
  };

  const svc = new RecordingRetentionService(
    { client: opts.noDb ? null : client } as never,
    {
      delete: jest.fn(async (key: string) => {
        if (opts.refuse?.(key)) throw new Error("bucket said no");
        deleted.push(key);
      }),
    } as never,
  );
  return { svc, store, deleted };
}

const past = new Date(Date.now() - 86_400_000);
const future = new Date(Date.now() + 86_400_000);
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id, schoolId: "s1", recordingKey: `lms/s1/live-${id}/x.mp4`, recordingSizeBytes: 1024, recordingExpiresAt: past, ...over,
});

describe("what the sweep removes", () => {
  it("removes the BYTES and keeps the row, saying when", async () => {
    const { svc, store, deleted } = harness([row("a")]);
    await expect(svc.purgeExpired()).resolves.toMatchObject({ removed: 1, failed: 0, bytesReclaimed: 1024 });
    expect(deleted).toEqual(["lms/s1/live-a/x.mp4"]);
    expect(store[0].recordingKey).toBeNull();
    // The row goes on saying WHY it is empty — "removed at the end of the year"
    // and "never recorded" are different facts.
    expect((store[0] as Row & { recordingRemovedAt?: Date }).recordingRemovedAt).toBeInstanceOf(Date);
  });

  it("leaves a recording whose year has not ended", async () => {
    const { svc, deleted } = harness([row("a", { recordingExpiresAt: future })]);
    await expect(svc.purgeExpired()).resolves.toMatchObject({ removed: 0 });
    expect(deleted).toEqual([]);
  });

  it("leaves the row intact when the store refuses, so the next run retries", async () => {
    // Clearing it anyway would strand the object for ever — the bytes are the
    // thing being removed, and the row is the only record of where they are.
    const { svc, store } = harness([row("a")], { refuse: () => true });
    await expect(svc.purgeExpired()).resolves.toMatchObject({ removed: 0, failed: 1, schoolsFailed: 1 });
    expect(store[0].recordingKey).not.toBeNull();
  });

  it("one school's failure does not end the fleet's sweep", async () => {
    // Catch per school, NAME it, COUNT it. A caught-and-logged error that
    // increments nothing reads exactly like a clean run.
    const { svc, store } = harness(
      [row("a", { schoolId: "s1" }), row("b", { schoolId: "s2" })],
      { refuse: (k) => k.includes("live-a") },
    );
    await expect(svc.purgeExpired()).resolves.toMatchObject({ removed: 1, failed: 1, schoolsFailed: 1 });
    expect(store.find((r) => r.id === "b")!.recordingKey).toBeNull();
  });

  it("says it SKIPPED when there is no privileged database", async () => {
    // A sweep returning zeros in silence reads as a quiet night — and this one
    // never running means footage of children is kept indefinitely.
    const { svc } = harness([row("a")], { noDb: true });
    await expect(svc.purgeExpired()).resolves.toMatchObject({ skipped: true, removed: 0 });
  });

  it("purges only the CALLER's school when one is named", async () => {
    // A teacher's press must never reach another school's recordings.
    const { svc, store } = harness([row("a", { schoolId: "s1" }), row("b", { schoolId: "s2" })]);
    await expect(svc.purgeExpired("MANUAL", "s1")).resolves.toMatchObject({ removed: 1 });
    expect(store.find((r) => r.id === "b")!.recordingKey).not.toBeNull();
  });
});

describe("a capped sweep that actually advances", () => {
  it("reaches, on the next run, what the cap left behind", async () => {
    // THE PROPERTY. Clearing `recordingKey` takes the row out of the predicate
    // the page is drawn from, so run two sees what run one could not.
    const n = RECORDING_RETENTION_BATCH + 25;
    const { svc, store } = harness(Array.from({ length: n }, (_, i) => row(`r${i}`)));

    const first = await svc.purgeExpired();
    expect(first).toMatchObject({ removed: RECORDING_RETENTION_BATCH, backlog: 25 });

    const second = await svc.purgeExpired();
    expect(second).toMatchObject({ removed: 25, backlog: 0 });

    expect(store.every((r) => r.recordingKey === null)).toBe(true);
    await expect(svc.purgeExpired()).resolves.toMatchObject({ removed: 0, backlog: 0 });
  });

  it("reports the BACKLOG counted on the SAME predicate the page is drawn from", async () => {
    const { svc } = harness(Array.from({ length: RECORDING_RETENTION_BATCH + 7 }, (_, i) => row(`r${i}`)));
    await expect(svc.purgeExpired()).resolves.toMatchObject({ backlog: 7 });
  });
});
