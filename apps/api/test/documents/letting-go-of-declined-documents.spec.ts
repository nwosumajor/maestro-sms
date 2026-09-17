// =============================================================================
// Letting go of documents belonging to families the school turned down
// =============================================================================
// Asking a family for a birth certificate before anyone has decided anything is
// the right trade for the ones who are accepted. It also means the platform ends
// up holding a minor's identity documents for every family it REJECTED, and
// keeping those indefinitely is the thing to avoid — it is what makes the whole
// "optional at apply" choice defensible.
//
// THE ORDERING IS THE PROPERTY. Bytes first, then the row. The row is the only
// record of where the object lives, so clearing it before the delete has
// succeeded leaves a birth certificate in the bucket that nothing can ever find
// again — the exact opposite of what this sweep is for.
//
// THE SECOND PROPERTY IS PROGRESS, and it is why this double now honours the
// CAP. The sweep used to page over declined APPLICATIONS and write only to
// `document_submission`, so the same 500 applications matched every night and
// nothing past them was ever reached. The old double's `findMany` ignored
// `take` entirely, so one run cleared the whole fixture and every test here
// passed — the fixture trap this repo keeps meeting, in its quietest form.
// =============================================================================

import { Logger } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { REJECTED_SUBMISSION_RETENTION_DAYS } from "@sms/types";
import { RETENTION_BATCH, SubmissionRetentionService } from "../../src/documents/submission-retention.service";

type Row = Record<string, unknown>;

function build(opts: { applications?: Row[]; submissions?: Row[]; deleteFails?: boolean; noPrivileged?: boolean } = {}) {
  const submissions: Row[] = opts.submissions ?? [];
  const applications: Row[] = opts.applications ?? [];
  const order: string[] = [];

  /** The rows the real query selects: a file still HELD, whose application was
   *  declined and is past the window. Modelled as the join it is, and capped
   *  with the service's own constant — a double that ignores the cap cannot
   *  see the defect the cap causes. */
  const dueRows = (cutoff: Date, onlySchoolId?: string) =>
    submissions.filter((sub) => {
      if (sub.storageKey === null || sub.subjectKind !== "ADMISSION_APPLICATION") return false;
      if (onlySchoolId && sub.schoolId !== onlySchoolId) return false;
      const app = applications.find((a) => a.id === sub.subjectId);
      return !!app && app.status === "REJECTED" && (app.updatedAt as Date) < cutoff;
    });

  const client = {
    // ONE raw query in two shapes — the page and the count over the SAME
    // predicate. Told apart the way the server tells them apart.
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      const cutoff = q.values.find((v) => v instanceof Date) as Date;
      const onlySchoolId = q.values.find((v) => typeof v === "string") as string | undefined;
      const due = dueRows(cutoff, onlySchoolId);
      if (q.sql.includes("count(")) return [{ total: due.length }];
      return due.slice(0, RETENTION_BATCH).map((sub) => ({
        id: sub.id,
        storageKey: sub.storageKey,
        subjectId: sub.subjectId,
      }));
    }),
    documentSubmission: {
      update: ({ where, data }: { where: { id: string }; data: Row }) => {
        order.push(`row:${where.id}`);
        Object.assign(submissions.find((s) => s.id === where.id)!, data);
        return Promise.resolve({});
      },
    },
  };
  const storage = {
    delete: (key: string) => {
      order.push(`bytes:${key}`);
      return opts.deleteFails ? Promise.reject(new Error("bucket said no")) : Promise.resolve();
    },
  };
  const svc = new SubmissionRetentionService(
    { client: opts.noPrivileged ? null : client } as never,
    storage as never,
  );
  return { svc, submissions, order };
}

const longAgo = new Date(Date.now() - (REJECTED_SUBMISSION_RETENTION_DAYS + 10) * 86_400_000);
const recently = new Date(Date.now() - 3 * 86_400_000);

const declined = (id = "app-1", at = longAgo) => ({ id, schoolId: "s1", status: "REJECTED", updatedAt: at });
const withFile = (id: string, appId = "app-1") => ({
  id, schoolId: "s1", subjectId: appId, subjectKind: "ADMISSION_APPLICATION",
  storageKey: `schools/s1/submissions/${id}`, contentType: "application/pdf", sizeBytes: 900, status: "UPLOADED",
});

describe("what the sweep removes", () => {
  beforeEach(() => { jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {}); jest.spyOn(Logger.prototype, "log").mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  it("removes the FILE and keeps the record", async () => {
    // What was asked for, what arrived and what was decided stays legible. The
    // birth certificate does not.
    const { svc, submissions } = build({ applications: [declined()], submissions: [withFile("s-1")] });
    await expect(svc.purgeRejected()).resolves.toMatchObject({ filesPurged: 1, rowsCleared: 1, failed: 0 });
    expect(submissions[0]).toMatchObject({ storageKey: null, contentType: null, sizeBytes: null });
    expect(String(submissions[0].rejectedReason)).toMatch(/Removed \d+ days after the application was declined/);
  });

  it("deletes the bytes BEFORE clearing the row", async () => {
    // The property the whole sweep turns on: the row is the only record of
    // where the object lives.
    const { svc, order } = build({ applications: [declined()], submissions: [withFile("s-1")] });
    await svc.purgeRejected();
    expect(order).toEqual(["bytes:schools/s1/submissions/s-1", "row:s-1"]);
  });

  it("leaves the row intact when the store refuses, so the next run retries", async () => {
    // Clearing it anyway would strand the object for ever.
    const { svc, submissions, order } = build({ applications: [declined()], submissions: [withFile("s-1")], deleteFails: true });
    await expect(svc.purgeRejected()).resolves.toMatchObject({ filesPurged: 0, rowsCleared: 0, failed: 1 });
    expect(submissions[0].storageKey).toBe("schools/s1/submissions/s-1");
    expect(order).toEqual(["bytes:schools/s1/submissions/s-1"]);
  });

  it("does not touch an application declined recently", async () => {
    const { svc, submissions } = build({ applications: [declined("app-1", recently)], submissions: [withFile("s-1")] });
    await expect(svc.purgeRejected()).resolves.toMatchObject({ applications: 0, filesPurged: 0 });
    expect(submissions[0].storageKey).toBeTruthy();
  });

  it("does not touch an application that was never declined", async () => {
    // An accepted family's documents belong to their child now; a pending one's
    // are still being waited on.
    const { svc, submissions } = build({
      applications: [{ id: "app-1", schoolId: "s1", status: "ACCEPTED", updatedAt: longAgo }],
      submissions: [withFile("s-1")],
    });
    await expect(svc.purgeRejected()).resolves.toMatchObject({ applications: 0, filesPurged: 0 });
    expect(submissions[0].storageKey).toBeTruthy();
  });

  it("says it SKIPPED when there is no privileged database", async () => {
    // A sweep that returns zeros in silence reads as a quiet night — and this
    // one never running means a privacy obligation quietly going unmet.
    const warned: string[] = [];
    jest.spyOn(Logger.prototype, "warn").mockImplementation((m: unknown) => { warned.push(String(m)); });
    const { svc } = build({ noPrivileged: true, applications: [declined()], submissions: [withFile("s-1")] });
    await expect(svc.purgeRejected()).resolves.toMatchObject({ skipped: true, filesPurged: 0 });
    expect(warned.join(" ")).toMatch(/no privileged DB/i);
  });

  it("keeps going across several declined applications", async () => {
    const { svc } = build({
      applications: [declined("app-1"), declined("app-2")],
      submissions: [withFile("s-1", "app-1"), withFile("s-2", "app-2")],
    });
    await expect(svc.purgeRejected()).resolves.toMatchObject({ applications: 2, filesPurged: 2, rowsCleared: 2 });
  });

  it("does not count a declined family who sent nothing as work", async () => {
    // The page is drawn from FILES STILL HELD, so an application with nothing
    // attached is not examined at all. It used to be counted as an application
    // "examined", which is how a run that achieved nothing reported 500.
    const { svc } = build({ applications: [declined()], submissions: [] });
    await expect(svc.purgeRejected()).resolves.toMatchObject({ applications: 0, filesPurged: 0, failed: 0 });
  });

  it("MAKES PROGRESS: what a capped run leaves behind is reached by the next one", async () => {
    // The defect this suite could not see. The sweep's only write is to
    // `document_submission`, so a page drawn from APPLICATIONS matched the same
    // rows every night for ever. Measured against a real database before the
    // fix: run one cleared 409 files, runs two, three and four each reported
    // `applications: 500, filesPurged: 0`, and 191 declined families' birth
    // certificates were still held — with `backlog` frozen at 475,036.
    const n = RETENTION_BATCH + 120;
    const applications = Array.from({ length: n }, (_, i) => declined(`app-${i}`));
    const submissions = applications.map((a, i) => withFile(`s-${i}`, String(a.id)));
    const { svc } = build({ applications, submissions });

    const first = await svc.purgeRejected();
    expect(first).toMatchObject({ filesPurged: RETENTION_BATCH, backlog: 120 });

    const second = await svc.purgeRejected();
    expect(second).toMatchObject({ filesPurged: 120, backlog: 0 });

    // Nothing is left holding bytes, and a third run has nothing to do.
    expect(submissions.every((s) => s.storageKey === null)).toBe(true);
    await expect(svc.purgeRejected()).resolves.toMatchObject({ applications: 0, filesPurged: 0, backlog: 0 });
  });
});
