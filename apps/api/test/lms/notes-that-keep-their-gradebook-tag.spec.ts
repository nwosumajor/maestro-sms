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

function makeService(opts: {
  titleTakenIn?: string[];
  cannotAuthorIn?: string[];
  /** arms with no plan for this (subject, term) at all */
  armsWithoutPlan?: string[];
  /** arm classId -> the topic ITS week 3 actually covers */
  armWeekTopics?: Record<string, string>;
} = {}) {
  const { titleTakenIn = [], cannotAuthorIn = [], armsWithoutPlan = [], armWeekTopics = {} } = opts;
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
      // The offerings this user teaches — the SOURCE class plus the arms they
      // can author in. Drawn from the same set `findFirst` answers over: one
      // table queried two ways must not give two different answers, and this
      // double used to omit the source from the list while confirming it by id,
      // so a caller who held an offering there was a teacher of it to one
      // question and a stranger to the other.
      findMany: jest.fn(async () =>
        [{ id: SRC.classId }, ...ARMS]
          .filter((x) => !cannotAuthorIn.includes(x.id))
          .map((x) => ({ classId: x.id })),
      ),
    },
    classTeacher: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
    lmsContentRevision: { create: jest.fn(async () => ({})), count: jest.fn(async () => 0) },
    auditLog: { create: jest.fn(async () => ({})) },
    user: { findFirst: jest.fn(async () => ({ name: "A Teacher" })) },
    // The source week, and each arm's plan, for the re-pointing lookup.
    subjectSyllabusItem: {
      findFirst: jest.fn(async () => ({
        week: 3,
        topic: "Motion",
        syllabus: { subjectId: "sub-physics", termId: "term-1" },
      })),
      // Only arms whose plan has a week 3 ABOUT MOTION match. `armWeekTopics`
      // decides that, so a plan with a different week 3 is expressible.
      findMany: jest.fn(async (a: { where: { syllabusId: { in: string[] }; week: number; topic: string } }) =>
        a.where.syllabusId.in
          .filter((sid) => (armWeekTopics[sid.replace("plan-", "")] ?? "Motion") === a.where.topic)
          .map((sid) => ({ id: `item-${sid}`, syllabusId: sid })),
      ),
    },
    subjectSyllabus: {
      findMany: jest.fn(async (a: { where: { classId: { in: string[] } } }) =>
        a.where.classId.in
          .filter((c) => !armsWithoutPlan.includes(c))
          .map((c) => ({ id: `plan-${c}`, classId: c })),
      ),
    },
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
  return { svc, created, tx };
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

  it("DROPS the module id, which means nothing in the target", async () => {
    // `LmsModule` is class-scoped: the source class's module list does not exist
    // in another arm.
    const { svc, created } = makeService();
    await svc.copyContentToArms(admin, SRC.id);
    expect(created.every((c) => c.moduleId === null)).toBe(true);
  });

  it("NEVER carries the source's own syllabus item across", async () => {
    // The invariant that holds however the week lookup behaves: an item belongs
    // to ONE arm's plan, so pointing another arm's note at it would attach a note
    // to a week in a different class.
    const { svc, created } = makeService();
    await svc.copyContentToArms(admin, SRC.id);
    expect(created.every((c) => c.syllabusItemId !== SRC.syllabusItemId)).toBe(true);
  });

  it("attaches to the ARM'S OWN week when the plans demonstrably correspond", async () => {
    // Safe because the syllabus copy creates an arm's weeks from the same
    // source, so after that they match by construction — same number, same topic.
    const { svc, created } = makeService();
    const r = await svc.copyContentToArms(admin, SRC.id);
    expect(created.map((c) => c.syllabusItemId)).toEqual(["item-plan-c-b", "item-plan-c-c"]);
    expect(r.copied.every((c) => c.week)).toBe(true);
  });

  it("leaves it UNTAGGED when the arm's week 3 is about something else", async () => {
    // The topic check is the whole safeguard: it distinguishes "this plan came
    // from the same place" from "this arm happens to have a week 3". Untagged is
    // recoverable; the wrong week is not.
    const { svc, created } = makeService({ armWeekTopics: { "c-c": "Electricity" } });
    const r = await svc.copyContentToArms(admin, SRC.id);
    expect(created.map((c) => c.syllabusItemId)).toEqual(["item-plan-c-b", null]);
    expect(r.copied.map((c) => c.week)).toEqual([true, false]);
  });

  it("leaves it UNTAGGED when the arm has no plan for that term at all", async () => {
    const { svc, created } = makeService({ armsWithoutPlan: ["c-b", "c-c"] });
    await svc.copyContentToArms(admin, SRC.id);
    expect(created.every((c) => c.syllabusItemId === null)).toBe(true);
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

describe("it costs the same at ten arms as at two", () => {
  it("resolves every arm's week in TWO queries, not one per arm", async () => {
    // A lookup per arm is the shape that degrades quietly: correct at two arms,
    // and ten queries at ten. The plans are fetched once and the matching weeks
    // once, both by `id: { in: [...] }`.
    const { svc, tx } = makeService();
    await svc.copyContentToArms(admin, SRC.id);
    const plans = (tx as unknown as { subjectSyllabus: { findMany: jest.Mock } }).subjectSyllabus.findMany;
    const items = (tx as unknown as { subjectSyllabusItem: { findMany: jest.Mock } }).subjectSyllabusItem.findMany;
    expect(plans).toHaveBeenCalledTimes(1);
    expect(items).toHaveBeenCalledTimes(1);
    // ...and both asked for ALL the arms at once, which is what makes it one query.
    expect(plans.mock.calls[0][0].where.classId.in).toHaveLength(ARMS.length);
  });

  it("does not look for a week at all when the note has none", async () => {
    // A material with no syllabus item costs nothing extra.
    const { svc, tx } = makeService();
    (SRC as { syllabusItemId: string | null }).syllabusItemId = null;
    await svc.copyContentToArms(admin, SRC.id);
    (SRC as { syllabusItemId: string | null }).syllabusItemId = "item-a";
    expect((tx as unknown as { subjectSyllabus: { findMany: jest.Mock } }).subjectSyllabus.findMany).not.toHaveBeenCalled();
  });
});
});
