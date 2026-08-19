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
// =============================================================================

import { Logger } from "@nestjs/common";
import { REJECTED_SUBMISSION_RETENTION_DAYS } from "@sms/types";
import { SubmissionRetentionService } from "../../src/documents/submission-retention.service";

type Row = Record<string, unknown>;

function build(opts: { applications?: Row[]; submissions?: Row[]; deleteFails?: boolean; noPrivileged?: boolean } = {}) {
  const submissions: Row[] = opts.submissions ?? [];
  const order: string[] = [];
  const client = {
    admissionApplication: {
      findMany: ({ where }: { where: Record<string, unknown> }) => {
        const cutoff = (where.updatedAt as { lt: Date }).lt;
        return Promise.resolve(
          (opts.applications ?? []).filter(
            (a) => a.status === where.status && (a.updatedAt as Date) < cutoff,
          ),
        );
      },
    },
    documentSubmission: {
      findMany: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(submissions.filter((s) => s.subjectId === where.subjectId && s.storageKey !== null)),
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
  id, subjectId: appId, subjectKind: "ADMISSION_APPLICATION",
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

  it("has nothing to do when a declined family sent nothing", async () => {
    const { svc } = build({ applications: [declined()], submissions: [] });
    await expect(svc.purgeRejected()).resolves.toMatchObject({ applications: 1, filesPurged: 0, failed: 0 });
  });
});
