// =============================================================================
// A recorded lesson is footage of named children
// =============================================================================
// So the posture is deliberately narrower than the rest of the LMS: the
// teachers of that class, and the pupils who were IN it. A GUARDIAN is refused
// playback even though they can see the session happened — a recording shows
// other people's children, and a parent watching it is a disclosure those
// families never agreed to (Golden Rule #5). That is a decision, and this is
// where it is written down in a form that fails if somebody widens it.
//
// The other property is the one the whole storage change exists for: playback
// hands back an INLINE grant, and no attachment op is ever minted for a
// recording. It is not a claim the video cannot be captured — anything a
// browser plays can be recorded off the screen, and this module's own integrity
// principles say client-side measures are friction rather than enforcement.
// What it removes is every easy path, and it makes each watch an audited fact.
// =============================================================================

import { LmsContentService } from "../../src/lms/lms-content.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const CLASS = "c-biology";
const OTHER_CLASS = "c-history";
const SESSION = "s-1";
const SCHOOL = "school-A";
const KEY = `lms/${SCHOOL}/live-${SESSION}/1700000000_lesson.mp4`;

const who = (roles: string[], userId: string): Principal => ({
  schoolId: SCHOOL,
  userId,
  roles,
  permissions: ["lms.content.read", "lms.content.write"],
});

const TEACHER = who(["teacher"], "u-teacher");        // teaches CLASS
const OTHER_TEACHER = who(["teacher"], "u-other");    // teaches OTHER_CLASS only
const PUPIL = who(["student"], "u-pupil");            // enrolled in CLASS
const OUTSIDER = who(["student"], "u-outsider");      // enrolled in OTHER_CLASS
const GUARDIAN = who(["parent"], "u-guardian");       // parent of PUPIL

type SessionRow = Record<string, unknown>;

function harness(session: SessionRow, opts: { bytes?: Buffer } = {}) {
  const audit: string[] = [];
  const deleted: string[] = [];
  let stored: SessionRow = { ...session };

  const tx = {
    lmsLiveSession: {
      findFirst: jest.fn(async () => (stored.id === SESSION ? stored : null)),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        stored = { ...stored, ...data };
        return stored;
      }),
    },
    // Who teaches what — `classIdsTaughtBy` reads BOTH of these.
    class: {
      findMany: jest.fn(async ({ where }: { where: { supervisorId?: string } }) =>
        where?.supervisorId === TEACHER.userId ? [{ id: CLASS }]
          : where?.supervisorId === OTHER_TEACHER.userId ? [{ id: OTHER_CLASS }]
          : [],
      ),
      findFirst: jest.fn(async () => ({ id: CLASS })),
    },
    classSubjectTeacher: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
    enrollment: {
      findFirst: jest.fn(async ({ where }: { where: { classId: string; studentId?: unknown } }) => {
        const sid = where.studentId as string | { in: string[] } | undefined;
        const ids = typeof sid === "string" ? [sid] : Array.isArray((sid as { in?: string[] })?.in) ? (sid as { in: string[] }).in : [];
        if (where.classId === CLASS && ids.includes(PUPIL.userId)) return { id: "e-1" };
        if (where.classId === OTHER_CLASS && ids.includes(OUTSIDER.userId)) return { id: "e-2" };
        return null;
      }),
      findMany: jest.fn(async () => []),
    },
    parentChild: {
      findMany: jest.fn(async ({ where }: { where: { parentId: string } }) =>
        where.parentId === GUARDIAN.userId ? [{ studentId: PUPIL.userId }] : [],
      ),
    },
    academicSession: { findFirst: jest.fn(async () => ({ endDate: new Date("2027-07-31") })) },
    user: { findMany: jest.fn(async () => [{ id: TEACHER.userId, name: "Ada Teacher" }]), findFirst: jest.fn(async () => ({ name: "Ada Teacher" })) },
  } as unknown as TenantTx;

  const storage = {
    // The double MODELS THE CONTRACT: presignDownload takes the inline TYPE and
    // the op is derived from it, so a test can assert which grant was minted.
    presignUpload: jest.fn(async ({ key }: { key: string }) => ({ url: `https://bucket/${key}?put`, key, expiresInSeconds: 600 })),
    presignDownload: jest.fn(async (a: { key: string; inline?: string; filename?: string }) => ({
      url: `https://bucket/${a.key}?op=${a.inline ? `get-inline:${a.inline}` : "get"}`,
      key: a.key,
      expiresInSeconds: 600,
    })),
    download: jest.fn(async () => opts.bytes ?? null),
    delete: jest.fn(async (k: string) => { deleted.push(k); }),
  };

  const svc = new LmsContentService(
    {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    // `record(entry, tx)` — the ENTRY is the first argument. A double shaped to
    // the wrong argument silently records nothing and the assertion fails as
    // though the service never audited.
    { record: jest.fn(async (e: { action: string }) => { audit.push(e.action); }) } as never,
    {} as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn() } as never,
    storage as never,
    {} as never,
  );
  return { svc, storage, audit, deleted, current: () => stored };
}

/** An MP4 the sniffer will accept. */
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftyp"), Buffer.from("isom"), Buffer.alloc(32),
]);

const recorded = (extra: SessionRow = {}): SessionRow => ({
  id: SESSION, classId: CLASS, subjectId: null, title: "Photosynthesis",
  provider: "ZOOM", startsAt: new Date("2026-05-04T09:00:00Z"), durationMinutes: 60,
  status: "ENDED", hostId: TEACHER.userId, createdAt: new Date("2026-05-01T09:00:00Z"),
  recordingKey: KEY, recordingSizeBytes: 12345, recordingUploadedAt: new Date("2026-05-04T11:00:00Z"),
  recordingExpiresAt: new Date("2027-07-31"), recordingRemovedAt: null, ...extra,
});

describe("who may watch a recording", () => {
  it("a pupil who was IN the class can play it", async () => {
    const { svc, storage } = harness(recorded());
    const out = await svc.playRecording(PUPIL, SESSION);
    expect(out.url).toContain("get-inline:video/mp4");
    expect(storage.presignDownload).toHaveBeenCalledWith(expect.objectContaining({ inline: "video/mp4" }));
  });

  it("the class's teacher can play it", async () => {
    const { svc } = harness(recorded());
    await expect(svc.playRecording(TEACHER, SESSION)).resolves.toMatchObject({ url: expect.any(String) });
  });

  it("A GUARDIAN CANNOT — footage of other people's children", async () => {
    // The deliberate narrowing. A parent sees attendance and grades; a recording
    // of the room shows every other child in it.
    const { svc } = harness(recorded());
    await expect(svc.playRecording(GUARDIAN, SESSION)).rejects.toThrow();
  });

  it("a pupil from ANOTHER class cannot", async () => {
    const { svc } = harness(recorded());
    await expect(svc.playRecording(OUTSIDER, SESSION)).rejects.toThrow();
  });

  it("a teacher who does not teach the class cannot upload to it", async () => {
    const { svc } = harness(recorded());
    await expect(
      svc.presignRecording(OTHER_TEACHER, SESSION, { fileName: "x.mp4", contentType: "video/mp4", sizeBytes: 10 }),
    ).rejects.toThrow(/not found/i); // 404, never 403 — no cross-scope existence disclosure
  });

  it("records WHO watched, every time", async () => {
    // A signed URL cannot be reconstructed after the event, so the watch has to
    // be written down when the grant is made.
    const { svc, audit } = harness(recorded());
    await svc.playRecording(PUPIL, SESSION);
    expect(audit).toContain("lms.live.recording.play");
  });
});

describe("what playback hands back", () => {
  it("mints an INLINE grant, never an attachment", async () => {
    const { svc, storage } = harness(recorded());
    await svc.playRecording(PUPIL, SESSION);
    const arg = storage.presignDownload.mock.calls[0][0] as { inline?: string; filename?: string };
    expect(arg.inline).toBe("video/mp4");
    // No filename: that parameter exists to name a DOWNLOAD, and asking for one
    // is how an inline grant quietly becomes a save-to-disk.
    expect(arg.filename).toBeUndefined();
  });

  it("never puts the storage key on the wire", async () => {
    // A key plus any signature is a link. The DTO carries whether a recording
    // EXISTS; getting one is a separate, audited, short-lived grant.
    const { svc } = harness(recorded());
    const dto = await svc.deleteRecording(TEACHER, SESSION);
    expect(JSON.stringify(dto)).not.toContain(KEY);
    expect(Object.keys(dto)).not.toContain("recordingKey");
    expect(dto.hasRecording).toBe(false);
  });

  it("says a recording was REMOVED rather than reading as never recorded", async () => {
    // Two different facts, and only one of them needs explaining to a pupil who
    // came back to revise.
    const { svc } = harness(recorded({ recordingKey: null, recordingRemovedAt: new Date("2027-08-01") }));
    await expect(svc.playRecording(PUPIL, SESSION)).rejects.toThrow(/removed at the end of the academic session/i);
  });

  it("says plainly when there was never one", async () => {
    const { svc } = harness(recorded({ recordingKey: null, recordingRemovedAt: null }));
    await expect(svc.playRecording(PUPIL, SESSION)).rejects.toThrow(/No recording available/i);
  });
});

describe("confirming an upload", () => {
  it("refuses a key belonging to another session", async () => {
    // Otherwise a teacher could attach any object in the bucket to their own
    // lesson — including another class's recording.
    const { svc } = harness(recorded({ recordingKey: null }), { bytes: MP4 });
    await expect(
      svc.confirmRecording(TEACHER, SESSION, `lms/${SCHOOL}/live-someone-else/x.mp4`),
    ).rejects.toThrow(/does not belong to this session/i);
  });

  it("refuses bytes that are not an MP4, whatever the upload claimed", async () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(32)]);
    const { svc } = harness(recorded({ recordingKey: null }), { bytes: pdf });
    await expect(svc.confirmRecording(TEACHER, SESSION, KEY)).rejects.toThrow(/not an MP4/i);
  });

  it("refuses when nothing arrived — an upload is a CLAIM until the bytes are there", async () => {
    const { svc } = harness(recorded({ recordingKey: null }));
    await expect(svc.confirmRecording(TEACHER, SESSION, KEY)).rejects.toThrow(/has arrived/i);
  });

  it("dates the purge from the academic session the lesson was taught in", async () => {
    const { svc, current } = harness(recorded({ recordingKey: null }), { bytes: MP4 });
    await svc.confirmRecording(TEACHER, SESSION, KEY);
    expect((current().recordingExpiresAt as Date).toISOString().slice(0, 10)).toBe("2027-07-31");
    // A re-upload must clear the removal, or the screen offers Playback while
    // telling the pupil there is nothing to watch.
    expect(current().recordingRemovedAt).toBeNull();
  });
});
