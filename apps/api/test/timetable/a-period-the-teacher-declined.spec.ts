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
