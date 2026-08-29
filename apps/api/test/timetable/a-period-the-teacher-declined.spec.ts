/**
 * The teacher said they cannot teach then, and only the generator listened.
 *
 * `teacher_unavailability` is a HARD constraint in `generateTimetable` — driven
 * live for the first time: a teacher marked unavailable for all ten Monday
 * periods got 0 Monday lessons, where the same run with the constraint cleared
 * gave them 1. The teaching-load card deducts it too, "so a part-timer is not
 * shown as under-used".
 *
 * `assertNoConflict` — the guard on placing a lesson BY HAND, and on editing one
 * — checked three double-bookings (class, teacher, room) and never asked. So the
 * auto-generated grid honoured a declaration and one drag past it did not,
 * silently, and the 409 the UI printed named only "class, teacher, or room".
 *
 * Live after: place while available 201, place into a declined slot 409 with the
 * reason, and an existing entry still editable in place.
 */
import { ConflictException } from "@nestjs/common";
import { TimetableService } from "../../src/timetable/timetable.service";
import type { TenantTx } from "../../src/integrity/integrity.foundation";

const SLOT = { dayOfWeek: "MONDAY", periodId: "p1", teacherId: "t1" };

function make(opts: { declined?: boolean; existing?: Record<string, string> | null } = {}) {
  const tx = {
    teacherUnavailability: {
      findFirst: jest.fn(async () => (opts.declined ? { id: "u1" } : null)),
    },
    timetableEntry: {
      // No double-bookings: this test is about the fourth reason only.
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) =>
        args.where.id && !("dayOfWeek" in args.where) ? (opts.existing ?? null) : null,
      ),
    },
  } as unknown as TenantTx;
  const svc = Object.create(TimetableService.prototype) as TimetableService;
  return { svc, tx };
}

const check = (svc: TimetableService, tx: TenantTx, entry: Record<string, unknown>, excludeId?: string) =>
  (svc as unknown as {
    assertNoConflict: (t: TenantTx, e: unknown, id?: string) => Promise<void>;
  }).assertNoConflict(tx, entry, excludeId);

describe("a period the teacher declined", () => {
  it("refuses a NEW lesson in a slot the teacher marked unavailable", async () => {
    const { svc, tx } = make({ declined: true });
    await expect(check(svc, tx, { ...SLOT, classId: "c1" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("says which reason it is, not just that there is a conflict", async () => {
    // Three clashes and this one are four different problems with four different
    // fixes; "conflict" alone sends a timetabler hunting.
    const { svc, tx } = make({ declined: true });
    await expect(check(svc, tx, { ...SLOT, classId: "c1" })).rejects.toThrow(/marked this period as unavailable/i);
  });

  it("still places a lesson when the teacher has not declined that slot", async () => {
    const { svc, tx } = make({ declined: false });
    await expect(check(svc, tx, { ...SLOT, classId: "c1" })).resolves.toBeUndefined();
  });

  it("does NOT freeze an entry that already sits in a now-declined slot", async () => {
    // An entry placed before the teacher declared themselves unavailable must
    // stay editable — changing its ROOM must not be blocked by where it already
    // is. Freezing legacy rows is the trap the exam-hall capacity guard avoided.
    const { svc, tx } = make({ declined: true, existing: SLOT });
    await expect(check(svc, tx, { ...SLOT, classId: "c1" }, "e1")).resolves.toBeUndefined();
  });

  it("refuses when an edit MOVES a lesson into a declined slot", async () => {
    // The other half: the row exists, but somewhere else. Moving it in is a new
    // placement and is refused like one.
    const { svc, tx } = make({
      declined: true,
      existing: { dayOfWeek: "TUESDAY", periodId: "p1", teacherId: "t1" },
    });
    await expect(check(svc, tx, { ...SLOT, classId: "c1" }, "e1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses when an edit swaps in a teacher who declined that slot", async () => {
    const { svc, tx } = make({
      declined: true,
      existing: { dayOfWeek: "MONDAY", periodId: "p1", teacherId: "someone-else" },
    });
    await expect(check(svc, tx, { ...SLOT, classId: "c1" }, "e1")).rejects.toBeInstanceOf(ConflictException);
  });
});

/**
 * The third path that hands somebody a period.
 *
 * `assignCover` asked whether the reliever is still employed, is not the absent
 * teacher, and has no clash — and never whether they had declared the period
 * unavailable. It is the sharpest of the three: cover is assigned at short
 * notice, the reliever is NOTIFIED and expected to turn up, and the feature
 * exists so a class is not left unattended. Rostering the one person who told
 * the school they cannot be there produces exactly the empty room the clash
 * checks prevent.
 */
import { LessonCoverService } from "../../src/timetable/lesson-cover.service";

const ENTRY = { id: "e1", teacherId: "absent-1", dayOfWeek: "MONDAY", periodId: "p1", classId: "c1" };

function makeCover(declined: boolean) {
  const upsert = jest.fn(async () => ({ id: "cov-1" }));
  const tx = {
    // Answers the two queries differently, as the database would: fetching the
    // lesson by id returns it, and the clash probe (by teacher + slot) finds
    // nothing. A stub that returns the entry for both makes the reliever clash
    // with the very lesson they are covering.
    timetableEntry: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) =>
        args.where.id ? ENTRY : null,
      ),
    },
    user: { findFirst: jest.fn(async () => ({ id: "t1", name: "A Reliever", status: "ACTIVE" })) },
    // APPLIES THE CALLER'S OWN `where` to a one-row table, rather than
    // answering from a flag. A stub that ignores the query cannot tell a
    // correct lookup from one that dropped `periodId` — proved by mutation:
    // removing the period from the where left every assertion green until this
    // filtered properly.
    teacherUnavailability: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
        if (!declined) return null;
        const row = { teacherId: "t1", dayOfWeek: "MONDAY", periodId: "p1" };
        const w = args.where as Partial<typeof row>;
        const matches =
          (w.teacherId === undefined || w.teacherId === row.teacherId) &&
          (w.dayOfWeek === undefined || w.dayOfWeek === row.dayOfWeek) &&
          w.periodId === row.periodId; // the period is REQUIRED: a query without it is wrong
        return matches ? { id: "u1" } : null;
      }),
    },
    lessonCover: { findFirst: jest.fn(async () => null), upsert },
    class: { findFirst: jest.fn(async () => ({ name: "JSS1" })) },
    period: { findFirst: jest.fn(async () => ({ name: "P1", startTime: "08:00" })) },
    // A real TenantTx has both: the cover path takes an advisory lock on the
    // reliever before deciding, so two assigners cannot both see a clear diary.
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => 0),
  } as unknown as TenantTx;
  const svc = Object.create(LessonCoverService.prototype) as LessonCoverService;
  Object.assign(svc as unknown as Record<string, unknown>, {
    db: { runAsTenant: (_c: unknown, fn: (t: TenantTx) => unknown) => fn(tx) },
    audit: { record: jest.fn(async () => undefined) },
    notifications: { enqueue: jest.fn(async () => undefined), enqueueMany: jest.fn(async () => ({ created: 0, failed: 0 })) },
    ctx: () => ({ schoolId: "S", userId: "u" }),
    region: { todayInTx: jest.fn(async () => new Date("2026-08-31T00:00:00.000Z")) },
  });
  return { svc, upsert };
}

const assign = (svc: LessonCoverService) =>
  (svc as unknown as {
    assignCover: (p: unknown, i: unknown) => Promise<unknown>;
  }).assignCover({ schoolId: "S", userId: "u", roles: ["school_admin"], permissions: [] }, {
    timetableEntryId: "e1",
    date: "2026-08-31",
    coveringTeacherId: "t1",
  });

describe("cover is a period too", () => {
  it("refuses a reliever who declared that period unavailable", async () => {
    const { svc, upsert } = makeCover(true);
    await expect(assign(svc)).rejects.toThrow(/marked this period as unavailable/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("names the reliever, so the assigner knows who to replace", async () => {
    const { svc } = makeCover(true);
    await expect(assign(svc)).rejects.toThrow(/A Reliever/);
  });

  it("assigns normally when they have not declined it", async () => {
    const { svc, upsert } = makeCover(false);
    await assign(svc);
    expect(upsert).toHaveBeenCalled();
  });
});
