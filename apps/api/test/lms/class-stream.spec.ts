// =============================================================================
// Streams and arms
// =============================================================================
// Both were previously encoded in the class NAME and nowhere else, so a year's
// streams could only be grouped by string match — and the string drifted
// ("SS3 Sci A", "SS3-SCIENCE-A", "SS3 Science 1"). These are the two rules that
// keep the structured fields and the visible name from ever disagreeing.
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { composeClassName, sameStreamGroup, parseStreamRef, streamAudienceRef } from "@sms/types";
import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantTx } from "../../src/integrity/integrity.foundation";

const admin = { userId: "a1", schoolId: "s1", roles: ["school_admin"], permissions: [] } as unknown as Principal;

describe("composing a class name from what was chosen", () => {
  it("names a streamed senior arm", () => {
    expect(composeClassName({ stage: "SENIOR_SECONDARY", level: 3, stream: "SCIENCE", arm: "A" })).toBe("SS3 Science A");
  });

  it("omits the arm when the stream is one class", () => {
    expect(composeClassName({ stage: "SENIOR_SECONDARY", level: 3, stream: "COMMERCIAL", arm: null })).toBe("SS3 Commercial");
  });

  it("treats GENERAL as no stream at all in the name", () => {
    // A school that does not stream should not read "JSS1 General B" on every
    // report card — GENERAL is how "we do not stream" is stored, not a label.
    expect(composeClassName({ stage: "JUNIOR_SECONDARY", level: 1, stream: "GENERAL", arm: "B" })).toBe("JSS1 B");
  });

  it("spaces primary and nursery, but not JSS/SS", () => {
    expect(composeClassName({ stage: "PRIMARY", level: 4, stream: null, arm: null })).toBe("Primary 4");
    expect(composeClassName({ stage: "SENIOR_SECONDARY", level: 1, stream: null, arm: null })).toBe("SS1");
  });

  it("returns nothing when it cannot name anything", () => {
    // The caller then keeps whatever the school typed, which is how a
    // house-named class ("Blue House") survives.
    expect(composeClassName({ stage: null, level: 3, stream: "SCIENCE", arm: "A" })).toBe("");
    expect(composeClassName({ stage: "SENIOR_SECONDARY", level: null, stream: "SCIENCE", arm: "A" })).toBe("");
  });
});

describe("which classes are the same stream group", () => {
  const ss3sci = { stage: "SENIOR_SECONDARY", level: 3, stream: "SCIENCE" };

  it("arms of one stream match", () => {
    expect(sameStreamGroup(ss3sci, { ...ss3sci, arm: "B" })).toBe(true);
  });

  it("a different YEAR is a different group", () => {
    // The trap: "Science" alone spans SS1, SS2 and SS3.
    expect(sameStreamGroup(ss3sci, { ...ss3sci, level: 2 })).toBe(false);
  });

  it("a different stream and a different stage are different groups", () => {
    expect(sameStreamGroup(ss3sci, { ...ss3sci, stream: "ART" })).toBe(false);
    expect(sameStreamGroup(ss3sci, { ...ss3sci, stage: "JUNIOR_SECONDARY" })).toBe(false);
  });

  it("an unstreamed class never groups on a null stage or level", () => {
    expect(sameStreamGroup({ stage: null, level: null, stream: null }, { stage: null, level: null, stream: null })).toBe(false);
  });
});

describe("the stream audience reference", () => {
  it("round-trips", () => {
    expect(parseStreamRef(streamAudienceRef("SENIOR_SECONDARY", 3, "SCIENCE"))).toEqual({
      stage: "SENIOR_SECONDARY",
      level: 3,
      stream: "SCIENCE",
    });
  });

  it("rejects anything malformed rather than half-reading it", () => {
    // A half-parsed ref would resolve to the wrong set of parents.
    expect(parseStreamRef("SENIOR_SECONDARY:SCIENCE")).toBeNull();
    expect(parseStreamRef("SENIOR_SECONDARY:x:SCIENCE")).toBeNull();
    expect(parseStreamRef("")).toBeNull();
  });
});

describe("copying a subject set across the arms", () => {
  function harness(opts: {
    source?: Record<string, unknown> | null;
    siblings?: Array<{ id: string }>;
    offerings?: Array<{ subjectId: string; teacherId: string; lessonsPerWeek: number | null }>;
  }) {
    let createArgs: { data: unknown[]; skipDuplicates?: boolean } | null = null;
    const tx = {
      class: {
        findFirst: jest.fn().mockResolvedValue(
          opts.source === undefined
            ? { id: "c1", stage: "SENIOR_SECONDARY", level: 3, stream: "SCIENCE", name: "SS3 Science A" }
            : opts.source,
        ),
        findMany: jest.fn().mockResolvedValue(opts.siblings ?? [{ id: "c2" }, { id: "c3" }]),
      },
      classSubjectTeacher: {
        findMany: jest.fn().mockResolvedValue(
          opts.offerings ?? [
            { subjectId: "phy", teacherId: "t1", lessonsPerWeek: 4 },
            { subjectId: "chm", teacherId: "t2", lessonsPerWeek: 3 },
          ],
        ),
        createMany: jest.fn((args: { data: unknown[]; skipDuplicates?: boolean }) => {
          createArgs = args;
          return Promise.resolve({ count: args.data.length });
        }),
      },
    } as unknown as TenantTx;
    const db = { runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    const svc = new LmsService(db as never, { record: jest.fn().mockResolvedValue(undefined) } as never);
    return { svc, tx, get createArgs() { return createArgs; } };
  }

  it("writes every arm x subject in ONE insert", async () => {
    // Two arms, two subjects. The cost must not grow a statement per arm — that
    // is the whole reason to have this action rather than repeating the form.
    const h = harness({});
    await expect(h.svc.copySubjectsToArms(admin, "c1")).resolves.toEqual({ arms: 2, created: 4 });
    expect(h.tx.classSubjectTeacher.createMany).toHaveBeenCalledTimes(1);
    expect(h.createArgs?.data).toHaveLength(4);
  });

  it("skips duplicates, so an arm keeps its own teacher", async () => {
    // Copying over an arm's existing assignment would be worse than not copying:
    // the whole set would silently take arm A's teachers.
    const h = harness({});
    await h.svc.copySubjectsToArms(admin, "c1");
    expect(h.createArgs?.skipDuplicates).toBe(true);
  });

  it("queries siblings by stage, level AND stream", async () => {
    const h = harness({});
    await h.svc.copySubjectsToArms(admin, "c1");
    expect(h.tx.class.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: "c1" },
          stage: "SENIOR_SECONDARY",
          level: 3,
          stream: "SCIENCE",
        }),
      }),
    );
  });

  it("refuses when the class has no stage or year", async () => {
    const h = harness({ source: { id: "c1", stage: null, level: null, stream: null, name: "Blue House" } });
    await expect(h.svc.copySubjectsToArms(admin, "c1")).rejects.toThrow(/stage and year/i);
  });

  it("refuses when there are no other arms, rather than reporting success", async () => {
    const h = harness({ siblings: [] });
    await expect(h.svc.copySubjectsToArms(admin, "c1")).rejects.toThrow(/no other arms/i);
  });

  it("refuses when the source has no subjects", async () => {
    const h = harness({ offerings: [] });
    await expect(h.svc.copySubjectsToArms(admin, "c1")).rejects.toThrow(/no subjects/i);
  });

  it("404s an unknown class", async () => {
    const h = harness({ source: null });
    await expect(h.svc.copySubjectsToArms(admin, "nope")).rejects.toThrow(NotFoundException);
  });
});

// =============================================================================
// The class overview must not become one query per class
// =============================================================================
// The list now carries WHO TEACHES WHAT, not just counts. That is exactly the
// kind of addition that quietly turns a page into N+1 — a school with sixty
// classes would fire sixty offering reads on every load.

describe("class overview cost", () => {
  function overviewHarness(classCount: number, subjectsPerClass: number) {
    const classes = Array.from({ length: classCount }, (_, i) => ({
      id: `c${i}`,
      name: `SS1 Science ${String.fromCharCode(65 + i)}`,
      code: null,
      level: 1,
      capacity: null,
      nextClassId: null,
      supervisorId: "sup1",
      stage: "SENIOR_SECONDARY",
      stream: "SCIENCE",
      arm: String.fromCharCode(65 + i),
    }));
    const offerings = classes.flatMap((c) =>
      Array.from({ length: subjectsPerClass }, (_, j) => ({ classId: c.id, subjectId: `s${j}`, teacherId: `t${j}` })),
    );
    const calls: string[] = [];
    const track = <T,>(name: string, value: T) => {
      calls.push(name);
      return Promise.resolve(value);
    };
    const tx = {
      class: { findMany: jest.fn(() => track("class.findMany", classes)) },
      enrollment: { groupBy: jest.fn(() => track("enrollment.groupBy", [])) },
      classTeacher: { groupBy: jest.fn(() => track("classTeacher.groupBy", [])), findMany: jest.fn(() => track("classTeacher.findMany", [])) },
      classSubjectTeacher: { findMany: jest.fn(() => track("offerings.findMany", offerings)) },
      subject: { findMany: jest.fn(() => track("subject.findMany", [{ id: "s0", name: "Biology" }, { id: "s1", name: "Physics" }])) },
      user: { findMany: jest.fn(() => track("user.findMany", [{ id: "sup1", name: "Form Teacher" }, { id: "t0", name: "Mr Bio" }, { id: "t1", name: "Ms Phys" }])) },
    } as unknown as TenantTx;
    const db = { runAsTenantReadOnly: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    const svc = new LmsService(db as never, { record: jest.fn() } as never);
    return { svc, calls };
  }

  const staff = { userId: "a1", schoolId: "s1", roles: ["school_admin"], permissions: [] } as unknown as Principal;

  it("costs the SAME number of queries for 2 classes as for 60", async () => {
    const small = overviewHarness(2, 2);
    await small.svc.listClassOverview(staff);
    const big = overviewHarness(60, 2);
    await big.svc.listClassOverview(staff);
    expect(big.calls.length).toBe(small.calls.length);
    // Named so a regression says WHICH read started repeating.
    expect(big.calls.filter((c) => c === "offerings.findMany")).toHaveLength(1);
  });

  it("pairs each subject with its teacher, sorted", async () => {
    const h = overviewHarness(1, 2);
    const [row] = (await h.svc.listClassOverview(staff)) as Array<{
      subjects: number;
      subjectTeachers: Array<{ subjectName: string; teacherName: string }>;
    }>;
    expect(row.subjects).toBe(2);
    // Insertion order here is ALREADY alphabetical, so this assertion fails if
    // the sort is removed OR reversed — with two items whose natural order
    // happens to reverse into sorted order, it would catch neither.
    expect(row.subjectTeachers.map((p) => `${p.subjectName}=${p.teacherName}`)).toEqual([
      "Biology=Mr Bio",
      "Physics=Ms Phys",
    ]);
  });

  it("names an unresolved teacher rather than dropping the subject", async () => {
    // A subject whose teacher row is missing must still appear — silently
    // omitting it would understate what the class offers.
    const h = overviewHarness(1, 3);
    const [row] = (await h.svc.listClassOverview(staff)) as Array<{ subjectTeachers: Array<{ teacherName: string }> }>;
    expect(row.subjectTeachers).toHaveLength(3);
    expect(row.subjectTeachers.some((p) => p.teacherName === "Unassigned")).toBe(true);
  });
});
