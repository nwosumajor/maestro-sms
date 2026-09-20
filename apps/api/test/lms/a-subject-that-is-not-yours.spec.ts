// =============================================================================
// A teacher's subject is theirs; the room is not
// =============================================================================
// The ordinary shape of a secondary school: Akinlabi Alex teaches MATHEMATICS
// to SS1 Science A. That makes him a teacher OF that class — he sees its roll,
// its diary, its pupils — and emphatically NOT the person who plans, publishes
// or schedules its PHYSICS, which belongs to Ehimen Success.
//
// Both halves are tested here because both were wrong in opposite ways:
//
//   WRITING  the subject tag on lesson notes had a guard that could not fire,
//            and the live class beside it had no guard at all. Measured live on
//            a real school: a Maths teacher created a Physics lesson AND a
//            Physics live class, 201 both times.
//   READING  content was narrowed to the subjects a pupil offers; the live
//            sessions added later were scoped by CLASS only, so a pupil who
//            never took Physics saw the Physics lesson and could join it.
//
// UNTAGGED is the deliberate hole in both: general class material and a whole-
// class meeting belong to the form tutor and address the room, so they stay
// open to any teacher of the class and visible to every pupil in it.
// =============================================================================

import { LmsContentService } from "../../src/lms/lms-content.service";
import type { Principal, TenantTx } from "../../src/integrity/integrity.foundation";

const CLASS = "cls-ss1-science-a";
const MATHS = "sub-maths";
const PHYSICS = "sub-physics";

const alex: Principal = {                   // teaches MATHS here, nothing else
  schoolId: "s1", userId: "u-alex", roles: ["teacher"],
  permissions: ["lms.content.read", "lms.content.write"],
};
const admin: Principal = {
  schoolId: "s1", userId: "u-admin", roles: ["school_admin"],
  permissions: ["lms.content.read", "lms.content.write"],
};
const pupilMaths: Principal = {             // offers MATHS only
  schoolId: "s1", userId: "u-pupil", roles: ["student"], permissions: ["lms.content.read"],
};

/** `taught` are the subjects the PRINCIPAL teaches in CLASS; `offers` what the
 *  CLASS runs; `selected` what the pupil takes. */
function harness(opts: {
  taught?: string[];
  offers?: string[];
  selected?: string[] | null;
  sessions?: Array<Record<string, unknown>>;
}) {
  const taught = opts.taught ?? [];
  const offers = opts.offers ?? [MATHS, PHYSICS];
  const created: Array<Record<string, unknown>> = [];
  const sessions = opts.sessions ?? [];
  const updated: Array<Record<string, unknown>> = [];
  let lastWhere: Record<string, unknown> = {};

  /** ONE predicate, shared by findMany and count — written twice is how a list
   *  and its total come to describe different populations. */
  const matching = (where: Record<string, unknown>) => {
    const or = (where as { OR?: Array<Record<string, unknown>> }).OR;
    if (!or) return sessions;
    return sessions.filter((r) =>
      or.some((c) =>
        c.subjectId === null
          ? r.subjectId === null
          : (c.subjectId as { in: string[] })?.in?.includes(r.subjectId as string),
      ),
    );
  };

  const tx = {
    classSubjectTeacher: {
      // THREE questions reach this table and must not share one answer:
      //   {classId, subjectId, teacherId} -> is this offering MINE
      //   {classId, subjectId}            -> does the CLASS run it
      //   {classId, teacherId}            -> do I teach anything here
      findFirst: jest.fn((a: { where: { teacherId?: string; subjectId?: string } }) => {
        const { teacherId, subjectId } = a.where;
        if (teacherId && subjectId) return Promise.resolve(taught.includes(subjectId) ? { id: "o" } : null);
        if (subjectId) return Promise.resolve(offers.includes(subjectId) ? { id: "o" } : null);
        if (teacherId) return Promise.resolve(taught.length ? { id: "o" } : null);
        return Promise.resolve(null);
      }),
      // Selects classId for "which classes do I teach", subjectId elsewhere.
      findMany: jest.fn((a?: { select?: Record<string, boolean> }) =>
        Promise.resolve(a?.select?.classId ? taught.map(() => ({ classId: CLASS })) : taught.map((s) => ({ subjectId: s }))),
      ),
    },
    class: { findFirst: jest.fn().mockResolvedValue({ id: CLASS }), findMany: jest.fn().mockResolvedValue([]) },
    enrollment: {
      findFirst: jest.fn().mockResolvedValue({ id: "e1" }),
      findMany: jest.fn().mockResolvedValue([{ classId: CLASS }]),
    },
    parentChild: { findMany: jest.fn().mockResolvedValue([]) },
    term: { findFirst: jest.fn().mockResolvedValue({ id: "term1", isCurrent: true }) },
    subjectSelection: {
      findFirst: jest.fn().mockResolvedValue(opts.selected ? { subjectIds: opts.selected } : null),
    },
    lmsLiveSession: {
      create: jest.fn((a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return Promise.resolve({ id: "ls1", hostId: alex.userId, ...a.data });
      }),
      // The session being read or edited. LOOKED UP BY ID, not a constant: a
      // double that hands back the same row whatever was asked for cannot test
      // a door that turns on WHICH session it was given.
      findFirst: jest.fn((a?: { where?: { id?: string } }) =>
        Promise.resolve(
          sessions.find((r) => r.id === a?.where?.id) ?? {
            id: "ls1", classId: CLASS, subjectId: null, title: "Assembly", provider: "JITSI",
            startsAt: new Date(Date.now() + 86_400_000), durationMinutes: 40, status: "SCHEDULED",
            hostId: alex.userId, joinUrl: "https://meet.jit.si/x", createdAt: new Date(),
            recordingKey: null, recordingSizeBytes: null, recordingUploadedAt: null,
            recordingExpiresAt: null, recordingRemovedAt: null,
          },
        ),
      ),
      update: jest.fn((a: { data: Record<string, unknown> }) => {
        updated.push(a.data);
        return Promise.resolve({
          id: "ls1", classId: CLASS, subjectId: null, title: "Assembly", provider: "JITSI",
          startsAt: new Date(), durationMinutes: 40, status: "SCHEDULED", hostId: alex.userId,
          createdAt: new Date(), recordingKey: null, recordingSizeBytes: null,
          recordingUploadedAt: null, recordingExpiresAt: null, recordingRemovedAt: null,
          ...a.data,
        });
      }),
      findMany: jest.fn((a: { where: Record<string, unknown>; take?: number }) => {
        lastWhere = a.where;
        // Honour the predicate AND the cap, or the double proves nothing about
        // either — a `take` a fixture ignores is how a cap goes unnoticed.
        const rows = matching(a.where);
        return Promise.resolve(typeof a.take === "number" ? rows.slice(0, a.take) : rows);
      }),
      // Counts the SAME set the page is drawn from, WITHOUT the cap. A double
      // that counts a different population is how a wrong total passes.
      count: jest.fn((a: { where: Record<string, unknown> }) => Promise.resolve(matching(a.where).length)),
    },
    lmsLiveAttendance: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "att" }),
    },
    subject: {
      findMany: jest.fn(() =>
        Promise.resolve([{ id: MATHS, name: "Mathematics" }, { id: PHYSICS, name: "Physics" }]),
      ),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: "u-alex", name: "Akinlabi Alex" }),
      findMany: jest.fn().mockResolvedValue([{ id: "u-alex", name: "Akinlabi Alex" }]),
    },
  } as unknown as TenantTx;

  const svc = new LmsContentService(
    {
      runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    { create: jest.fn(), review: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn() } as never,
    { presignUpload: jest.fn(), presignDownload: jest.fn() } as never,
    { getStudentSessionReport: jest.fn() } as never,
  );
  return { svc, created, updated, where: () => lastWhere };
}

const lesson = (subjectId?: string) => ({
  title: "Lesson", provider: "JITSI" as const, joinUrl: "https://meet.jit.si/x",
  startsAt: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 40, subjectId,
});

describe("hosting a live class", () => {
  it("a Maths teacher CANNOT host the class's Physics lesson", async () => {
    const { svc, created } = harness({ taught: [MATHS] });
    await expect(svc.createLiveSession(alex, CLASS, lesson(PHYSICS))).rejects.toThrow(/subject you teach/i);
    expect(created).toHaveLength(0);
  });

  it("…and CAN host their own Maths lesson", async () => {
    const { svc, created } = harness({ taught: [MATHS] });
    await svc.createLiveSession(alex, CLASS, lesson(MATHS));
    expect(created[0]).toMatchObject({ subjectId: MATHS, classId: CLASS });
  });

  it("…and CAN host an untagged whole-class session", async () => {
    // The form tutor's assembly. Untagged is not a loophole, it is the case
    // where no subject is being claimed.
    const { svc, created } = harness({ taught: [MATHS] });
    await svc.createLiveSession(alex, CLASS, lesson(undefined));
    expect(created[0]).toMatchObject({ subjectId: null });
  });

  it("school-wide staff are not narrowed", async () => {
    const { svc, created } = harness({ taught: [] });
    await svc.createLiveSession(admin, CLASS, lesson(PHYSICS));
    expect(created[0]).toMatchObject({ subjectId: PHYSICS });
  });
});

describe("what a pupil sees in the diary", () => {
  const rows = [
    { id: "a", classId: CLASS, subjectId: MATHS, title: "Maths", provider: "JITSI", startsAt: new Date(), durationMinutes: 40, status: "SCHEDULED", hostId: "u-alex", createdAt: new Date(), recordingKey: null, recordingSizeBytes: null, recordingUploadedAt: null, recordingExpiresAt: null, recordingRemovedAt: null },
    { id: "b", classId: CLASS, subjectId: PHYSICS, title: "Physics", provider: "JITSI", startsAt: new Date(), durationMinutes: 40, status: "SCHEDULED", hostId: "u-alex", createdAt: new Date(), recordingKey: null, recordingSizeBytes: null, recordingUploadedAt: null, recordingExpiresAt: null, recordingRemovedAt: null },
    { id: "c", classId: CLASS, subjectId: null, title: "Assembly", provider: "JITSI", startsAt: new Date(), durationMinutes: 40, status: "SCHEDULED", hostId: "u-alex", createdAt: new Date(), recordingKey: null, recordingSizeBytes: null, recordingUploadedAt: null, recordingExpiresAt: null, recordingRemovedAt: null },
  ];

  it("a pupil taking only Maths does not see the Physics lesson", async () => {
    const { svc } = harness({ taught: [], selected: [MATHS], sessions: rows });
    const seen = await svc.listLiveSessions(pupilMaths, CLASS);
    expect(seen.rows.map((s: { title: string }) => s.title).sort()).toEqual(["Assembly", "Maths"]);
    expect(seen.narrowedToMySubjects).toBe(true);
  });

  it("an untagged session is visible to every pupil in the class", async () => {
    const { svc } = harness({ taught: [], selected: ["something-else"], sessions: rows });
    const seen = await svc.listLiveSessions(pupilMaths, CLASS);
    expect(seen.rows.map((s: { title: string }) => s.title)).toEqual(["Assembly"]);
  });

  it("no approved selection narrows NOTHING — fail open, like content", async () => {
    // A school mid-migration has no selections. Hiding every lesson from every
    // pupil would be a worse failure than showing one they do not take.
    const { svc } = harness({ taught: [], selected: null, sessions: rows });
    const seen = await svc.listLiveSessions(pupilMaths, CLASS);
    expect(seen.rows).toHaveLength(3);
  });

  it("…and SAYS it failed open, rather than failing open in silence", async () => {
    // The pupil is seeing every subject. `false` is what lets the screen tell
    // them why, instead of leaving "you take them all" and "nobody has approved
    // your choices" looking identical.
    const { svc } = harness({ taught: [], selected: null, sessions: rows });
    expect((await svc.listLiveSessions(pupilMaths, CLASS)).narrowedToMySubjects).toBe(false);
  });

  it("a teacher of the class sees every subject in it", async () => {
    const { svc } = harness({ taught: [MATHS], selected: [MATHS], sessions: rows });
    const seen = await svc.listLiveSessions(alex, CLASS);
    expect(seen.rows).toHaveLength(3);
    // The rule does not apply to them — distinct from "applies and found none".
    expect(seen.narrowedToMySubjects).toBeNull();
  });
});

describe("re-tagging a session that is already there", () => {
  // A GUARD ON ONE DOOR IS NOT A GUARD. Create refused a teacher scheduling
  // under somebody else's subject; this door let them schedule it untagged and
  // PATCH the subject on a moment later, for the identical outcome.
  it("a Maths teacher CANNOT move a session onto Physics", async () => {
    const { svc, updated } = harness({ taught: [MATHS] });
    await expect(svc.updateLiveSession(alex, "ls1", { subjectId: PHYSICS })).rejects.toThrow(/subject you teach/i);
    expect(updated).toHaveLength(0);
  });

  it("…and CAN move it onto their own Maths", async () => {
    const { svc, updated } = harness({ taught: [MATHS] });
    await svc.updateLiveSession(alex, "ls1", { subjectId: MATHS });
    expect(updated[0]).toMatchObject({ subjectId: MATHS });
  });

  it("…and CAN clear the tag back to none", async () => {
    // `null` is the documented escape hatch for a session mis-filed under a
    // subject; it claims nothing, so it stays open to any teacher of the class.
    const { svc, updated } = harness({ taught: [MATHS] });
    await svc.updateLiveSession(alex, "ls1", { subjectId: null });
    expect(updated[0]).toMatchObject({ subjectId: null });
  });

  it("school-wide staff may re-file anything", async () => {
    const { svc, updated } = harness({ taught: [] });
    await svc.updateLiveSession(admin, "ls1", { subjectId: PHYSICS });
    expect(updated[0]).toMatchObject({ subjectId: PHYSICS });
  });
});

describe("a class that has been running for years", () => {
  // O(lifetime), not O(size): a class row outlives the year when a school
  // reuses it, and a timetabled class holds a live session per subject per
  // teaching day. This list had no cap at all.
  const many = Array.from({ length: 140 }, (_, i) => ({
    id: `s${i}`, classId: CLASS, subjectId: null, title: `Lesson ${i}`, provider: "JITSI",
    startsAt: new Date(), durationMinutes: 40, status: "ENDED", hostId: "u-alex",
    createdAt: new Date(), recordingKey: null, recordingSizeBytes: null,
    recordingUploadedAt: null, recordingExpiresAt: null, recordingRemovedAt: null,
  }));

  it("caps the panel and REPORTS what it is not showing", async () => {
    const { svc } = harness({ taught: [MATHS], sessions: many });
    const seen = await svc.listLiveSessions(alex, CLASS);
    expect(seen.rows.length).toBeLessThan(many.length);
    // The whole point of the total: fifty of a hundred and forty must not look
    // like a hundred and forty.
    expect(seen.total).toBe(140);
  });

  it("the total counts what the READER may see, not what the class holds", async () => {
    // Widening the reach must never widen the rule: a pupil's total is their
    // own subjects, or the count contradicts the list under it.
    const tagged = many.map((r, i) => ({ ...r, subjectId: i % 2 === 0 ? MATHS : PHYSICS }));
    const { svc } = harness({ taught: [], selected: [MATHS], sessions: tagged });
    const seen = await svc.listLiveSessions(pupilMaths, CLASS);
    expect(seen.total).toBe(70);
  });
});

describe("reaching one session by its id", () => {
  // HIDING A ROW FROM A LIST WHILE STILL SERVING IT BY ID MAKES THE FILTER
  // COSMETIC. Narrowing the panel stopped a pupil SEEING the Physics lesson;
  // these are the doors that would still have handed it over to anyone holding
  // the id — the join URL, and the recording of the lesson afterwards.
  const physicsNow = {
    id: "ls-physics", classId: CLASS, subjectId: PHYSICS, title: "Physics", provider: "JITSI",
    startsAt: new Date(Date.now() - 60_000), durationMinutes: 60, status: "LIVE",
    hostId: "u-success", joinUrl: "https://meet.jit.si/physics", createdAt: new Date(),
    recordingKey: "lms/recordings/physics.mp4", recordingSizeBytes: 10, recordingUploadedAt: new Date(),
    recordingExpiresAt: null, recordingRemovedAt: null,
  };

  /** A pupil who takes only Maths, looking at a Physics session. */
  function sessionHarness(selected: string[] | null) {
    const h = harness({ taught: [], selected, sessions: [physicsNow] });
    (h.svc as unknown as { db: unknown }); // service is already wired by harness
    return h;
  }

  it("a pupil who does not take Physics cannot JOIN the Physics lesson", async () => {
    const { svc } = sessionHarness([MATHS]);
    // 404, not 403: the refusal must not confirm what it hides.
    await expect(svc.joinLiveSession(pupilMaths, "ls-physics")).rejects.toThrow(/not found/i);
  });

  it("…nor PLAY its recording afterwards", async () => {
    const { svc } = sessionHarness([MATHS]);
    await expect(svc.playRecording(pupilMaths, "ls-physics")).rejects.toThrow(/not found/i);
  });

  it("a pupil who DOES take it is let through", async () => {
    const { svc } = sessionHarness([MATHS, PHYSICS]);
    await expect(svc.joinLiveSession(pupilMaths, "ls-physics")).resolves.toMatchObject({
      joinUrl: physicsNow.joinUrl,
    });
  });

  it("with no approved selection it fails OPEN here too, like the list", async () => {
    // The two halves must agree: a school mid-migration shows every subject in
    // the panel, so the door beside it cannot refuse what the panel offered.
    const { svc } = sessionHarness(null);
    await expect(svc.joinLiveSession(pupilMaths, "ls-physics")).resolves.toMatchObject({
      joinUrl: physicsNow.joinUrl,
    });
  });
});
