// =============================================================================
// Assigning a class teacher — and taking it back
// =============================================================================
// There was no removal route at all. A class-teacher assignment is the widest
// relationship in the product: the roster, the grades, the documents, and the
// right to publish untagged content to every pupil in the class. It could be
// granted and never revoked, so a mis-click or a change of form teacher left
// standing access with no way to withdraw it. Verified live before fixing —
// DELETE returned 404 (no route) and the teacher kept full class-wide access.
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantTx } from "../../src/integrity/integrity.foundation";

const admin = { userId: "a1", schoolId: "s1", roles: ["school_admin"], permissions: [] } as unknown as Principal;

function harness(opts: { classExists?: boolean; assignment?: { id: string } | null; teacherExists?: boolean } = {}) {
  const supervisorWrites: string[] = [];
  const tx = {
    // A class teacher IS the class supervisor: assigning one writes
    // `class.supervisorId`. The join table this used to write has been retired.
    class: {
      findFirst: jest.fn().mockResolvedValue(
        opts.classExists === false
          ? null
          : { id: "c1", name: "JSS2", supervisorId: opts.assignment === null ? null : "t1" },
      ),
      update: jest.fn((args: { data: { supervisorId: string } }) => {
        supervisorWrites.push(args.data.supervisorId);
        return Promise.resolve({});
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    // Same row the database would return, status included: a teacher who has
    // left can no longer be given a class.
    user: {
      findFirst: jest.fn().mockResolvedValue(
        opts.teacherExists === false ? null : { id: "t1", name: "T One", status: "ACTIVE" },
      ),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id, name: "T One", status: "ACTIVE" }))),
      ),
    },
    // A teaching duty goes to STAFF who are still here — one batched check for
    // a class teacher and for a whole class's subjects.
    userRole: {
      findMany: jest.fn(({ where }: { where: { userId: { in: string[] } } }) =>
        Promise.resolve(where.userId.in.map((userId) => ({ userId, role: { name: "teacher" } }))),
      ),
    },

    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new LmsService(db as never, audit as never), tx, supervisorWrites, audit };
}

describe("removing a class teacher", () => {
  it("REFUSES, because a class cannot be left without a class teacher", async () => {
    // This used to delete a join row, and removing the last one left a class
    // whose register was nobody's job — the state 30 of 31 classes were in.
    // A class teacher is the class SUPERVISOR and every class must have one, so
    // taking somebody off is done by putting somebody else on.
    const { svc } = harness();
    await expect(svc.removeTeacher(admin, "c1", "t1")).rejects.toThrow(/must have a class teacher/i);
  });

  it("404s when that teacher is not assigned here", async () => {
    const { svc } = harness({ assignment: null });
    await expect(svc.removeTeacher(admin, "c1", "t1")).rejects.toThrow(NotFoundException);
    // Nothing was written: the refusal comes before any change.
  });

  it("404s on a class in another school", async () => {
    // RLS already hides it; the service must not turn that into a 500 or leak
    // which of the two things was missing.
    const { svc } = harness({ classExists: false });
    await expect(svc.removeTeacher(admin, "other", "t1")).rejects.toThrow(NotFoundException);
  });

  it("names the way out rather than just refusing", async () => {
    // A refusal that does not say what to do instead sends somebody to support.
    const { svc } = harness();
    await expect(svc.removeTeacher(admin, "c1", "t1")).rejects.toThrow(/Assign a different one/i);
  });
});

describe("assigning a class teacher", () => {
  it("is idempotent — a double click is not an error", async () => {
    // It sets a single column now, so a second click simply writes the same
    // value. The join table it used to upsert into has been retired.
    const { svc, supervisorWrites } = harness();
    await svc.assignTeacher(admin, "c1", "t1");
    await svc.assignTeacher(admin, "c1", "t1");
    expect(supervisorWrites).toEqual(["t1", "t1"]);
  });

  it("404s on a teacher who does not exist", async () => {
    // The scalar FK has no Prisma relation, so an unknown id would otherwise
    // land as a foreign-key 500 at commit.
    const { svc } = harness({ teacherExists: false });
    await expect(svc.assignTeacher(admin, "c1", "ghost")).rejects.toThrow(NotFoundException);
  });
});

// =============================================================================
// Replacing a subject teacher
// =============================================================================
// One teacher per (class, subject) — a school with several Physics teachers
// gives them different arms, which is how timetabling works anyway. So the
// interesting case is a REPLACEMENT, and it used to be invisible twice over:
// the same 201 as a first assignment, and a placed timetable that silently kept
// naming the previous teacher.

describe("reassigning a class's subject teacher", () => {
  function subjHarness(opts: { previous?: string | null; scheduled?: number; newTeacherBusy?: number } = {}) {
    const scheduled = Array.from({ length: opts.scheduled ?? 0 }, (_, i) => ({
      id: `e${i}`,
      dayOfWeek: "MONDAY",
      periodId: `p${i}`,
    }));
    let movedWhere: unknown = null;
    const tx = {
      class: {
        findFirst: jest.fn().mockResolvedValue({ id: "c1", name: "SS1 Science A" }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([]) },
      subject: { findFirst: jest.fn().mockResolvedValue({ id: "phy", name: "Physics" }) },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: "t2", name: "Mr Previous", status: "ACTIVE" }),
        findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(where.id.in.map((id) => ({ id, name: "Mr Previous", status: "ACTIVE" }))),
        ),
      },
      userRole: {
        findMany: jest.fn(({ where }: { where: { userId: { in: string[] } } }) =>
          Promise.resolve(where.userId.in.map((userId) => ({ userId, role: { name: "teacher" } }))),
        ),
      },
      room: { findFirst: jest.fn().mockResolvedValue({ id: "r1" }) },
      classSubjectTeacher: {
        findFirst: jest.fn().mockResolvedValue(
          opts.previous === undefined ? { teacherId: "t-old" } : opts.previous ? { teacherId: opts.previous } : null,
        ),
        upsert: jest.fn().mockResolvedValue({ id: "o1", lessonsPerWeek: 2, preferredRoomId: null }), findMany: jest.fn().mockResolvedValue([]) },
      timetableEntry: {
        // The first call finds the previous teacher's lessons; the second looks
        // for slots the NEW teacher already occupies.
        findMany: jest
          .fn()
          .mockResolvedValueOnce(scheduled)
          .mockResolvedValueOnce(Array.from({ length: opts.newTeacherBusy ?? 0 }, (_, i) => ({ id: `b${i}` }))),
        updateMany: jest.fn((args: { where: unknown }) => {
          movedWhere = args.where;
          return Promise.resolve({ count: scheduled.length });
        }),
      },
    } as unknown as TenantTx;
    const db = { runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    const svc = new LmsService(db as never, { record: jest.fn().mockResolvedValue(undefined) } as never);
    return { svc, tx, get movedWhere() { return movedWhere; } };
  }

  it("reports WHO was replaced", async () => {
    const h = subjHarness({ previous: "t-old" });
    const out = (await h.svc.assignClassSubject(admin, "c1", "phy", "t-new")) as Record<string, unknown>;
    expect(out.replacedTeacherId).toBe("t-old");
    expect(out.replacedTeacherName).toBe("Mr Previous");
  });

  it("reports nothing replaced on a FIRST assignment", async () => {
    const h = subjHarness({ previous: null });
    const out = (await h.svc.assignClassSubject(admin, "c1", "phy", "t-new")) as Record<string, unknown>;
    expect(out.replacedTeacherId).toBeNull();
    expect(out.scheduledLessons).toBe(0);
  });

  it("still finds stranded lessons when re-assigning the SAME teacher", async () => {
    // The repair path. Replace without moving, and the placed lessons name a
    // third party; defining "stale" as the previous holder's lessons made them
    // unreachable for ever. Defined against the CURRENT holder, running the
    // assignment again with the box ticked fixes it.
    const h = subjHarness({ previous: "t-new", scheduled: 3 });
    const out = (await h.svc.assignClassSubject(admin, "c1", "phy", "t-new", {
      moveScheduledLessons: true,
    })) as Record<string, unknown>;
    expect(out.replacedTeacherId).toBeNull();
    expect(out.movedLessons).toBe(3);
  });

  it("re-assigning the SAME teacher is not a replacement", async () => {
    const h = subjHarness({ previous: "t-new" });
    const out = (await h.svc.assignClassSubject(admin, "c1", "phy", "t-new")) as Record<string, unknown>;
    expect(out.replacedTeacherId).toBeNull();
  });

  it("counts placed lessons still naming the old teacher, and does NOT move them by default", async () => {
    // A published timetable must not be rewritten by a roster edit — a cover
    // arrangement is a legitimate reason for the two to differ.
    const h = subjHarness({ previous: "t-old", scheduled: 3 });
    const out = (await h.svc.assignClassSubject(admin, "c1", "phy", "t-new")) as Record<string, unknown>;
    expect(out.scheduledLessons).toBe(3);
    expect(out.movedLessons).toBe(0);
    expect(h.tx.timetableEntry.updateMany).not.toHaveBeenCalled();
  });

  it("moves them when asked", async () => {
    const h = subjHarness({ previous: "t-old", scheduled: 3 });
    const out = (await h.svc.assignClassSubject(admin, "c1", "phy", "t-new", { moveScheduledLessons: true })) as Record<
      string,
      unknown
    >;
    expect(out.movedLessons).toBe(3);
    expect(h.movedWhere).toEqual({ id: { in: ["e0", "e1", "e2"] } });
  });

  it("refuses the move when the new teacher is already booked in those slots", async () => {
    // Moving into an occupied slot would violate the double-booking constraint.
    // Refusing the WHOLE change is deliberate: a half-moved timetable is worse
    // than an unmoved one, and the admin can assign without moving instead.
    const h = subjHarness({ previous: "t-old", scheduled: 3, newTeacherBusy: 2 });
    await expect(
      h.svc.assignClassSubject(admin, "c1", "phy", "t-new", { moveScheduledLessons: true }),
    ).rejects.toThrow(/already booked in 2 of those 3 slots/);
    expect(h.tx.timetableEntry.updateMany).not.toHaveBeenCalled();
  });
});
