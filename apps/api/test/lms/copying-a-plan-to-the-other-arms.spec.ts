// =============================================================================
// A scheme of work written three times, and notes copied one at a time
// =============================================================================
// `SubjectSyllabus` is keyed `(classId, subjectId, termId)` and `LmsContent.classId`
// is required, so SS1 Science A, B and C each need their own plan and their own
// copy of every note. Subjects already had `copy-to-arms` — "one action instead
// of one configuration per arm" — and the plan that says what to teach in which
// week did not. The only copy path for content was `clone`: one item to one
// class, so three arms of twelve notes is twenty-four operations.
//
// THE TWO DECISIONS THAT MAKE A BULK COPY SAFE, both taken from what this
// codebase had already decided rather than invented here:
//
//   SKIP, NEVER OVERWRITE. `copySubjectsToArms` uses `skipDuplicates` and says
//   why: it must be safe to press twice, and it must protect an arm that has
//   adjusted its own copy. The person who loses that work is not the person
//   pressing the button.
//
//   LAND AS DRAFT. `cloneContent` already sets `status: "DRAFT"` unconditionally.
//   Carrying approval would let one approval in SS1A publish into three arms
//   nobody reviewed — a control with a way round it is not a control.
//
// AND ONE DEPARTURE FROM `clone`, which is the point of having a separate action:
// it drops `subjectId`/`termId` on a cross-class copy, right for an arbitrary
// target and wrong for a sibling arm. Those are the GRADEBOOK TAG, they are
// school-wide ids, and across arms of one stream and year they are the same by
// construction. Dropping them turns one copy into twelve retagging jobs whose
// omission is invisible until a report card is short a CA component.
// =============================================================================

import { SyllabusService } from "../../src/lms/syllabus.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const teacher: Principal = { schoolId: "S", userId: "t-1", roles: ["teacher"], permissions: ["class.read"] };

const SOURCE = { id: "c-a", name: "SS1 Science A", stage: "SENIOR_SECONDARY", level: 1, stream: "SCIENCE" };
const ARMS = [
  { id: "c-b", name: "SS1 Science B", stage: "SENIOR_SECONDARY", level: 1, stream: "SCIENCE" },
  { id: "c-c", name: "SS1 Science C", stage: "SENIOR_SECONDARY", level: 1, stream: "SCIENCE" },
];
const WEEKS = [
  { week: 1, topic: "Measurement", objectives: "SI units", resources: null },
  { week: 2, topic: "Motion", objectives: null, resources: "Lab sheet" },
];

function makeService(opts: {
  /** arms that already have a plan for this (subject, term) */
  armsWithPlan?: string[];
  /** arms that do NOT offer the subject */
  armsWithoutSubject?: string[];
} = {}) {
  const { armsWithPlan = [], armsWithoutSubject = [] } = opts;
  const created: Array<{ classId: string; ownerId: string; overview: string | null }> = [];
  const items: Array<{ syllabusId: string; week: number; status?: string }> = [];
  const tx = {
    classSubjectTeacher: {
      findFirst: jest.fn(async (a: { where: { classId: string; teacherId?: string } }) => {
        if (a.where.teacherId) return { id: "cst" }; // the caller may write the source
        return armsWithoutSubject.includes(a.where.classId) ? null : { id: "cst", teacherId: `teacher-of-${a.where.classId}` };
      }),
      findMany: jest.fn(async () => [{ classId: "c-a", subjectId: "sub-1" }]),
    },
    subjectSyllabus: {
      findFirst: jest.fn(async (a: { where: { classId: string } }) =>
        a.where.classId === SOURCE.id
          ? { id: "syl-src", overview: "Term aims" }
          : armsWithPlan.includes(a.where.classId)
            ? { id: "existing" }
            : null,
      ),
      create: jest.fn(async (a: { data: { classId: string; ownerId: string; overview: string | null } }) => {
        created.push(a.data);
        return { id: `syl-${a.data.classId}` };
      }),
    },
    subjectSyllabusItem: {
      findMany: jest.fn(async () => WEEKS),
      createMany: jest.fn(async (a: { data: Array<{ syllabusId: string; week: number; status?: string }> }) => {
        items.push(...a.data);
        return { count: a.data.length };
      }),
    },
    class: {
      findFirst: jest.fn(async () => SOURCE),
      findMany: jest.fn(async () => ARMS),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  } as unknown as TenantTx;

  const svc = new SyllabusService(
    {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
  );
  const args = { classId: SOURCE.id, subjectId: "sub-1", termId: "term-1" };
  return { svc, args, created, items };
}

describe("copying a term plan to the other arms", () => {
  it("copies it to every sibling arm in one action", async () => {
    const { svc, args, created } = makeService();
    const r = await svc.copyToArms(teacher, args);
    expect(r.copied.map((c) => c.className)).toEqual(["SS1 Science B", "SS1 Science C"]);
    expect(created).toHaveLength(2);
  });

  it("carries the WEEKS and the term's aims — half a plan is not a plan", async () => {
    const { svc, args, created, items } = makeService();
    const r = await svc.copyToArms(teacher, args);
    expect(r.copied[0].weeks).toBe(WEEKS.length);
    expect(items).toHaveLength(WEEKS.length * 2);
    expect(created.every((c) => c.overview === "Term aims")).toBe(true);
  });

  it("copies weeks as PLANNED, never as taught", async () => {
    // `status` and `taughtAt` record what an arm actually taught. Carrying
    // "taught" across asserts a lesson that never happened in that room.
    const { svc, args, items } = makeService();
    await svc.copyToArms(teacher, args);
    expect(items.every((i) => i.status === undefined)).toBe(true);
  });

  it("gives the plan to the ARM'S OWN teacher, not to whoever pressed the button", async () => {
    // They are the person who will teach it and adjust week 6. A principal
    // copying to three arms would otherwise own plans they do not teach.
    const { svc, args, created } = makeService();
    await svc.copyToArms(teacher, args);
    expect(created.map((c) => c.ownerId)).toEqual(["teacher-of-c-b", "teacher-of-c-c"]);
  });
});

describe("what it refuses to trample", () => {
  it("SKIPS an arm that already has a plan, and says so", async () => {
    // Safe to press twice, and it protects an arm that has adjusted its copy.
    const { svc, args, created } = makeService({ armsWithPlan: ["c-b"] });
    const r = await svc.copyToArms(teacher, args);
    expect(r.copied.map((c) => c.className)).toEqual(["SS1 Science C"]);
    expect(r.skipped).toEqual([{ className: "SS1 Science B", reason: "already has a plan for this term" }]);
    expect(created).toHaveLength(1);
  });

  it("is idempotent — a second press copies nothing", async () => {
    const { svc, args } = makeService({ armsWithPlan: ["c-b", "c-c"] });
    const r = await svc.copyToArms(teacher, args);
    expect(r.copied).toEqual([]);
    expect(r.skipped).toHaveLength(2);
  });

  it("SKIPS an arm that does not offer the subject", async () => {
    // A Physics plan on an arm that teaches no Physics is a plan reachable from
    // nowhere and confusing when it is found.
    const { svc, args } = makeService({ armsWithoutSubject: ["c-c"] });
    const r = await svc.copyToArms(teacher, args);
    expect(r.copied.map((c) => c.className)).toEqual(["SS1 Science B"]);
    expect(r.skipped[0]).toMatchObject({ className: "SS1 Science C", reason: "does not offer this subject" });
  });
});
