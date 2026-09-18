// =============================================================================
// The size cap has TWO doors, and a refusal must name the way out
// =============================================================================
// `sizeBytes` at presign is a number the CALLER SENT — it bounds nothing on its
// own, and this repo has already met the shape where a claim is trusted because
// it arrived in a request body. The confirm is the only moment the server holds
// the bytes, so the cap is enforced there too, on `bytes.length`.
//
// Both doors are driven here BY DIRECT ID rather than through the call graph,
// because "a guard on one door is not a guard" is the second commonest defect
// in this codebase and reading the code is how it keeps being missed.
//
// The third property is the wording. A teacher refused with a number alone has
// no idea what to change — they have already recorded the lesson. The refusal
// names the RESOLUTION, which is the thing they can act on, and both doors
// share one message so they cannot drift into disagreeing about the advice.
// =============================================================================

import { LmsContentService } from "../../src/lms/lms-content.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";
import { MAX_RECORDING_BYTES } from "@sms/types";

const CLASS = "c-biology";
const SESSION = "s-1";
const SCHOOL = "school-A";
const KEY = `lms/${SCHOOL}/live-${SESSION}/1700000000_lesson.mp4`;

const TEACHER: Principal = {
  schoolId: SCHOOL,
  userId: "u-teacher",
  roles: ["teacher"],
  permissions: ["lms.content.read", "lms.content.write"],
};

/** An MP4 the sniffer accepts, padded to `size` so the cap is what refuses it. */
function mp4(size: number): Buffer {
  const head = Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftyp"), Buffer.from("isom"),
  ]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
}

function harness(bytes: Buffer | null) {
  const tx = {
    lmsLiveSession: {
      findFirst: jest.fn(async () => ({
        id: SESSION, classId: CLASS, subjectId: null, title: "Photosynthesis",
        provider: "ZOOM", startsAt: new Date("2026-05-04T09:00:00Z"), durationMinutes: 60,
        status: "ENDED", hostId: TEACHER.userId, createdAt: new Date("2026-05-01T09:00:00Z"),
        recordingKey: null, recordingSizeBytes: null, recordingUploadedAt: null,
        recordingExpiresAt: null, recordingRemovedAt: null,
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: SESSION, classId: CLASS, ...data })),
    },
    class: {
      findMany: jest.fn(async ({ where }: { where: { supervisorId?: string } }) =>
        where?.supervisorId === TEACHER.userId ? [{ id: CLASS }] : [],
      ),
      findFirst: jest.fn(async () => ({ id: CLASS })),
    },
    classSubjectTeacher: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
    enrollment: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    parentChild: { findMany: jest.fn(async () => []) },
    academicSession: { findFirst: jest.fn(async () => ({ endDate: new Date("2027-07-31") })) },
    user: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => ({ name: "Ada Teacher" })) },
  } as unknown as TenantTx;

  const storage = {
    presignUpload: jest.fn(async ({ key }: { key: string }) => ({ url: `https://bucket/${key}?put`, key, expiresInSeconds: 600 })),
    presignDownload: jest.fn(async (a: { key: string }) => ({ url: `https://bucket/${a.key}`, key: a.key, expiresInSeconds: 600 })),
    download: jest.fn(async () => bytes),
    delete: jest.fn(async () => undefined),
  };

  const svc = new LmsContentService(
    {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn(async () => undefined) } as never,
    {} as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn() } as never,
    storage as never,
    {} as never,
  );
  return { svc, storage };
}

const OVER = MAX_RECORDING_BYTES + 1;

describe("a recording bigger than the cap", () => {
  it("is refused at PRESIGN, before an hour is spent uploading it", async () => {
    const { svc, storage } = harness(null);
    await expect(
      svc.presignRecording(TEACHER, SESSION, { fileName: "lesson.mp4", contentType: "video/mp4", sizeBytes: OVER }),
    ).rejects.toThrow(/limit/i);
    // The point of refusing HERE is that nothing is signed: a teacher on a
    // 5 Mbps line does not discover the cap after uploading 2 GB.
    expect(storage.presignUpload).not.toHaveBeenCalled();
  });

  it("is refused again at CONFIRM, where the server actually holds the bytes", async () => {
    // `sizeBytes` at presign is the caller's own claim. A client that lies, or
    // simply sends a different file to the signed URL, meets the cap here.
    const { svc } = harness(mp4(OVER));
    await expect(svc.confirmRecording(TEACHER, SESSION, KEY)).rejects.toThrow(/limit/i);
  });

  it("names the way out — the resolution, not only the number", async () => {
    // A refusal a teacher cannot act on is the failure this wording exists for.
    // Asserted on BOTH doors, because one shared message is the only reason
    // they cannot come to disagree about the advice.
    const { svc } = harness(mp4(OVER));

    const presign = await svc
      .presignRecording(TEACHER, SESSION, { fileName: "lesson.mp4", contentType: "video/mp4", sizeBytes: OVER })
      .then(() => "", (e: Error) => e.message);
    const confirm = await svc
      .confirmRecording(TEACHER, SESSION, KEY)
      .then(() => "", (e: Error) => e.message);

    for (const message of [presign, confirm]) {
      expect(message).toMatch(/720p/);
      expect(message).toMatch(/two halves|separate sessions/i);
    }
    expect(presign).toBe(confirm);
  });
});

describe("the cap admits what a teacher actually records", () => {
  // The number is a decision, and this is where it is written down in a form
  // that fails if somebody lowers it to a round figure. 1.4 GB is two hours of
  // 720p with the camera on a speaker — the worst realistic case for a double
  // lesson. A 500 MB ceiling refuses it, and refuses 480p too.
  const TWO_HOURS_OF_720P = Math.round(1.4 * 1024 * 1024 * 1024);

  it("takes a two-hour 720p double lesson", async () => {
    const { svc, storage } = harness(null);
    await expect(
      svc.presignRecording(TEACHER, SESSION, {
        fileName: "double.mp4", contentType: "video/mp4", sizeBytes: TWO_HOURS_OF_720P,
      }),
    ).resolves.toMatchObject({ key: expect.stringContaining(`lms/${SCHOOL}/live-${SESSION}/`) });
    expect(storage.presignUpload).toHaveBeenCalled();
  });

  it("does NOT take a 1080p screen-recorder dump of the same lesson", async () => {
    // Over an hour of uploading on a school line, so admitting it would mostly
    // produce abandoned PUTs rather than lessons pupils can watch.
    const { svc } = harness(null);
    await expect(
      svc.presignRecording(TEACHER, SESSION, {
        fileName: "obs.mp4", contentType: "video/mp4", sizeBytes: Math.round(2.2 * 1024 * 1024 * 1024),
      }),
    ).rejects.toThrow(/limit/i);
  });
});
