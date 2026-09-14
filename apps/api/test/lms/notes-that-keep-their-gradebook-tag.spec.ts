// =============================================================================
// Copying notes to the other arms — and the tag that must survive the trip
// =============================================================================
// `clone` drops `subjectId` and `termId` whenever the target is a different
// class (`sameClass ? src.subjectId : null`). That is RIGHT for an arbitrary
// cross-class clone — the target may teach neither subject nor term — and WRONG
// for a sibling arm, where both are the same by construction.
//
// Those two fields are the GRADEBOOK TAG: the schema says a quiz or assignment
// tagged `(subjectId, termId)` "can be pulled into the SubjectResult assignment
// CA component", and both null means "not counted toward the report card". So
// dropping them turns one copy into twelve retagging jobs, and the omission is
// invisible until a report card is short a component.
//
// What must NOT survive: approval (a control with a way round it is not a
// control), and the class-scoped ids — `moduleId` belongs to the source class's
// module list and `syllabusItemId` to its own plan's week.
// =============================================================================

import { LmsContentService } from "../../src/lms/lms-content.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const teacher: Principal = { schoolId: "S", userId: "t-1", roles: ["teacher"], permissions: ["lms.content.write"] };
const admin: Principal = { schoolId: "S", userId: "adm", roles: ["school_admin"], permissions: ["lms.content.write"] };

const SRC = {
  id: "ct-1",
  classId: "c-a",
  type: "MATERIAL",
  title: "Week 3 — Motion",
  body: { blocks: [] },
  status: "APPROVED",
  authorId: "t-1",
  fileKey: null,
  fileName: null,
  fileUploaded: false,
  moduleId: "mod-a",
  syllabusItemId: "item-a",
  subjectId: "sub-physics",
  termId: "term-1",
};
const SOURCE_CLASS = { stage: "SENIOR_SECONDARY", level: 1, stream: "SCIENCE", name: "SS1 Science A" };
const ARMS = [
  { id: "c-b", name: "SS1 Science B" },
  { id: "c-c", name: "SS1 Science C" },
];

function makeService(opts: { titleTakenIn?: string[]; cannotAuthorIn?: string[] } = {}) {
  const { titleTakenIn = [], cannotAuthorIn = [] } = opts;
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    lmsContent: {
      findFirst: jest.fn(async (a: { where: { id?: string; classId?: string; title?: string } }) => {
        if (a.where.id) return SRC;
        return a.where.classId && titleTakenIn.includes(a.where.classId) ? { id: "dup" } : null;
      }),
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return { ...SRC, ...a.data, id: `new-${created.length}` };
      }),
    },
    class: {
      findFirst: jest.fn(async () => SOURCE_CLASS),
      // TWO DIFFERENT QUESTIONS reach this one stub: "which are the sibling
      // arms" (by stage/level/stream) and "which classes does this user
      // SUPERVISE" (by supervisorId, from classIdsTaughtBy). Answering ARMS to
      // both made the caller look like the supervisor of every arm, so the
      // authoring check passed and the test failed for the wrong reason.
      findMany: jest.fn(async (a: { where?: { supervisorId?: string } }) =>
        a?.where?.supervisorId ? [] : ARMS,
      ),
    },
    // `canAuthor` consults the teaching links for a non-school-wide caller.
    classSubjectTeacher: {
      findFirst: jest.fn(async (a: { where: { classId: string } }) =>
        cannotAuthorIn.includes(a.where.classId) ? null : { id: "cst" },
      ),
      // The offerings this user teaches — empty for the arms they do not.
      findMany: jest.fn(async () =>
        ARMS.filter((x) => !cannotAuthorIn.includes(x.id)).map((x) => ({ classId: x.id })),
      ),
    },
    classTeacher: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
    lmsContentRevision: { create: jest.fn(async () => ({})), count: jest.fn(async () => 0) },
    auditLog: { create: jest.fn(async () => ({})) },
    user: { findFirst: jest.fn(async () => ({ name: "A Teacher" })) },
  } as unknown as TenantTx;

  const svc = new LmsContentService(
    {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { createRequest: jest.fn(), submit: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn(), notifyPermissionHolders: jest.fn() } as never,
    { presignUpload: jest.fn(), presignDownload: jest.fn() } as never,
    { onFinalized: jest.fn() } as never,
  );
  return { svc, created };
}

describe("copying a note to the other arms", () => {
  it("KEEPS the gradebook tag, which a cross-class clone rightly drops", async () => {
    // The whole reason this is a separate action from `clone`.
    const { svc, created } = makeService();
    await svc.copyContentToArms(admin, SRC.id);
    expect(created).toHaveLength(2);
    expect(created.every((c) => c.subjectId === "sub-physics" && c.termId === "term-1")).toBe(true);
  });

  it("lands as DRAFT, so one approval cannot publish into arms nobody reviewed", async () => {
    const { svc, created } = makeService();
    await svc.copyContentToArms(admin, SRC.id);
    expect(created.every((c) => c.status === "DRAFT")).toBe(true);
    // The source was APPROVED — this is not an accident of the fixture.
    expect(SRC.status).toBe("APPROVED");
  });

  it("DROPS the class-scoped ids, which mean nothing in the target", async () => {
    // A module belongs to the source class's module list; a syllabus item to its
    // own plan's week. Re-pointing the week is deliberately not attempted —
    // nothing guarantees the plans correspond, and attaching notes to the wrong
    // week is worse than leaving them untagged.
    const { svc, created } = makeService();
    await svc.copyContentToArms(admin, SRC.id);
    expect(created.every((c) => c.moduleId === null && c.syllabusItemId === null)).toBe(true);
  });

  it("keeps the title, so a second press can recognise its own work", async () => {
    const { svc, created } = makeService();
    await svc.copyContentToArms(admin, SRC.id);
    expect(created.every((c) => c.title === SRC.title)).toBe(true);
  });
});

describe("what it refuses to trample", () => {
  it("SKIPS an arm that already has content with this title", async () => {
    const { svc, created } = makeService({ titleTakenIn: ["c-b"] });
    const r = await svc.copyContentToArms(admin, SRC.id);
    expect(r.copied.map((c) => c.className)).toEqual(["SS1 Science C"]);
    expect(r.skipped[0]).toMatchObject({ className: "SS1 Science B", reason: "already has content with this title" });
    expect(created).toHaveLength(1);
  });

  it("is idempotent — a second press copies nothing", async () => {
    const { svc } = makeService({ titleTakenIn: ["c-b", "c-c"] });
    const r = await svc.copyContentToArms(admin, SRC.id);
    expect(r.copied).toEqual([]);
    expect(r.skipped).toHaveLength(2);
  });

  it("will not write into an arm the caller could not write into one at a time", async () => {
    // A bulk door must not be easier to open than the single one.
    const { svc, created } = makeService({ cannotAuthorIn: ["c-b", "c-c"] });
    const r = await svc.copyContentToArms(teacher, SRC.id);
    expect(created).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["you do not teach this arm", "you do not teach this arm"]);
  });
});
