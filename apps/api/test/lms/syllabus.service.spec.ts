// =============================================================================
// SubjectSyllabus — who may plan, and what survives an edit
// =============================================================================
// Two behaviours carry the weight here:
//
//   • WRITING is for the person who teaches that subject to that class, checked
//     against the same class_subject_teacher row that decides who may enter its
//     marks — so planning and marking can never drift to different people
//   • an edit REPLACES the weeks, and the TAUGHT flags are carried across by
//     (week, topic). A teacher fixing a typo in week 9 must not lose the record
//     of having taught weeks 1-8; that record is the only thing that makes
//     "are we on schedule" answerable.

import { SyllabusService } from "../../src/lms/syllabus.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const teacher: Principal = { schoolId: "A", userId: "t1", roles: ["teacher"], permissions: ["class.read"] };
const head: Principal = { schoolId: "A", userId: "h1", roles: ["principal"], permissions: ["class.read"] };
const ARGS = { classId: "c1", subjectId: "s1", termId: "tm1" };

function harness(opts: {
  offerings?: Array<{ classId: string; subjectId: string }>;
  existing?: { id: string } | null;
  /** Rows already on the plan. A REAL row always carries its `id` and `status`;
   *  the service reads both now that a row keeps its identity across an edit. */
  priorTaught?: Array<{ week: number; topic: string; taughtAt: Date | null }>;
} = {}) {
  const created: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const tx = {
    classSubjectTeacher: {
      findFirst: jest.fn(({ where }: { where: { classId: string; subjectId: string } }) =>
        Promise.resolve(
          (opts.offerings ?? []).some((o) => o.classId === where.classId && o.subjectId === where.subjectId)
            ? { id: "off" }
            : null,
        ),
      ),
      findMany: jest.fn().mockResolvedValue(opts.offerings ?? []),
    },
    subjectSyllabus: {
      findFirst: jest.fn().mockResolvedValue(opts.existing ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "new-syl" }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn(({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
        return Promise.resolve({});
      }),
    },
    subjectSyllabusItem: {
      findMany: jest.fn().mockResolvedValue(
        (opts.priorTaught ?? []).map((t, i) => ({ id: `prior-${i}`, status: "TAUGHT", ...t })),
      ),
      deleteMany: jest.fn().mockResolvedValue({}),
      createMany: jest.fn(({ data }: { data: Array<Record<string, unknown>> }) => {
        created.push(...data);
        return Promise.resolve({ count: data.length });
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new SyllabusService(db as never, audit as never), created, deleted, tx };
}

const WEEKS = [
  { week: 1, topic: "Kinematics" },
  { week: 2, topic: "Newton's laws" },
];

describe("who may write a plan", () => {
  it("lets the teacher OF THAT OFFERING write it", async () => {
    const { svc, created } = harness({ offerings: [{ classId: "c1", subjectId: "s1" }] });
    await svc.upsert(teacher, ARGS, { items: WEEKS });
    expect(created).toHaveLength(2);
  });

  it("404s a teacher who teaches a DIFFERENT subject to that class", async () => {
    // The narrow case that matters: same class, wrong subject. A role check
    // alone would let them through.
    const { svc, created } = harness({ offerings: [{ classId: "c1", subjectId: "OTHER" }] });
    await expect(svc.upsert(teacher, ARGS, { items: WEEKS })).rejects.toThrow(/not found/i);
    expect(created).toHaveLength(0);
  });

  it("404s rather than 403s, so a probe reveals nothing", async () => {
    const { svc } = harness({ offerings: [] });
    await expect(svc.upsert(teacher, ARGS, { items: WEEKS })).rejects.toThrow(/not found/i);
  });

  it("lets leadership write any plan without teaching it", async () => {
    const { svc, created } = harness({ offerings: [] });
    await svc.upsert(head, ARGS, { items: WEEKS });
    expect(created).toHaveLength(2);
  });
});

describe("editing a plan keeps what was already taught", () => {
  const prior = [{ week: 1, topic: "Kinematics", taughtAt: new Date("2027-01-20") }];

  it("carries a TAUGHT week across an edit", async () => {
    // Replacing the rows must not silently reset progress to zero.
    const { svc, created } = harness({
      offerings: [{ classId: "c1", subjectId: "s1" }],
      existing: { id: "syl-1" },
      priorTaught: prior,
    });
    await svc.upsert(teacher, ARGS, { items: [{ week: 1, topic: "Kinematics" }, { week: 2, topic: "Newton's laws" }] });
    expect(created[0]).toMatchObject({ week: 1, status: "TAUGHT" });
    expect(created[1]).toMatchObject({ week: 2, status: "PLANNED" });
  });

  it("matches the carry case-insensitively, so a capitalisation fix is not a reset", async () => {
    const { svc, created } = harness({
      offerings: [{ classId: "c1", subjectId: "s1" }],
      existing: { id: "syl-1" },
      priorTaught: prior,
    });
    await svc.upsert(teacher, ARGS, { items: [{ week: 1, topic: "  KINEMATICS  " }] });
    expect(created[0]).toMatchObject({ status: "TAUGHT" });
  });

  it("does NOT carry when the topic genuinely changed — that is a different week", async () => {
    const { svc, created } = harness({
      offerings: [{ classId: "c1", subjectId: "s1" }],
      existing: { id: "syl-1" },
      priorTaught: prior,
    });
    await svc.upsert(teacher, ARGS, { items: [{ week: 1, topic: "Thermodynamics" }] });
    expect(created[0]).toMatchObject({ status: "PLANNED", taughtAt: null });
  });

  it("does not carry across a week number change either", async () => {
    const { svc, created } = harness({
      offerings: [{ classId: "c1", subjectId: "s1" }],
      existing: { id: "syl-1" },
      priorTaught: prior,
    });
    await svc.upsert(teacher, ARGS, { items: [{ week: 5, topic: "Kinematics" }] });
    expect(created[0]).toMatchObject({ status: "PLANNED" });
  });
});

describe("input the plan refuses", () => {
  const ok = { offerings: [{ classId: "c1", subjectId: "s1" }] };

  it("refuses a week outside 1-60", async () => {
    const { svc } = harness(ok);
    await expect(svc.upsert(teacher, ARGS, { items: [{ week: 0, topic: "x" }] })).rejects.toThrow(/between 1 and 60/);
    await expect(svc.upsert(teacher, ARGS, { items: [{ week: 61, topic: "x" }] })).rejects.toThrow(/between 1 and 60/);
  });

  it("refuses a fractional week", async () => {
    const { svc } = harness(ok);
    await expect(svc.upsert(teacher, ARGS, { items: [{ week: 1.5, topic: "x" }] })).rejects.toThrow(/whole number/);
  });

  it("refuses an entry with no topic", async () => {
    const { svc } = harness(ok);
    await expect(svc.upsert(teacher, ARGS, { items: [{ week: 1, topic: "   " }] })).rejects.toThrow(/needs a topic/);
  });

  it("refuses more than 60 entries", async () => {
    const { svc } = harness(ok);
    const many = Array.from({ length: 61 }, (_, i) => ({ week: 1, topic: `t${i}` }));
    await expect(svc.upsert(teacher, ARGS, { items: many })).rejects.toThrow(/more than 60/);
  });

  it("validates BEFORE writing anything", async () => {
    // A partial write would leave a plan half-replaced.
    const { svc, created } = harness(ok);
    await expect(svc.upsert(teacher, ARGS, { items: [{ week: 1, topic: "ok" }, { week: 0, topic: "bad" }] })).rejects.toThrow();
    expect(created).toHaveLength(0);
  });

  it("refuses an unknown item status", async () => {
    const { svc } = harness(ok);
    await expect(svc.setItemStatus(teacher, "i1", "DONE")).rejects.toThrow(/must be one of/);
  });
});
