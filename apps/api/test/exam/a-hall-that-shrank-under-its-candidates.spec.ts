/**
 * A hall cannot shrink below the candidates already seated in it.
 *
 * `seat` refuses to place more students than the hall holds (409). Nothing
 * guarded the other side: the sitting's capacity is editable afterwards —
 * directly, or by moving the sitting to a SMALLER ROOM, which resolves that
 * room's capacity — so the check was bypassed by changing the number it
 * compares against.
 *
 * Measured live: a class of 59 seated in a hall of 60, then set to capacity 5,
 * returned HTTP 200 and left 59 candidates holding seat numbers 1..59.
 *
 * The exam-day board already warns on this, and its own comment says the warning
 * is for sittings that "predate the check" — a backstop for legacy rows, not a
 * licence to create the state fresh. It also only appears on the day itself,
 * far too late to move a hall.
 *
 * Third module with this shape: the hostel room got it right, the bus did not,
 * and neither did the exam hall.
 */
import { ConflictException } from "@nestjs/common";
import { ExamService } from "../../src/exam/exam.service";

function makeService(opts: { capacity: number; seated: number; roomCapacity?: number }) {
  const current = {
    id: "sit-1", title: "Maths", subject: "Maths",
    date: new Date("2026-09-20"), startsAt: "09:00", endsAt: "11:00",
    hall: "Hall A", roomId: null as string | null, capacity: opts.capacity,
    note: null, classId: "cls-1",
  };
  const update = jest.fn().mockResolvedValue({ ...current, capacity: 5 });
  const tx = {
    examSitting: {
      findFirst: jest.fn().mockResolvedValue(current),
      findMany: jest.fn().mockResolvedValue([]),
      update,
    },
    examSeat: { count: jest.fn().mockResolvedValue(opts.seated) },
    // The success path builds the DTO, which reads these. A real TenantTx always
    // has them; a stub without them models something the database cannot produce.
    examInvigilator: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    class: { findFirst: jest.fn().mockResolvedValue({ id: "cls-1", name: "JSS2 A" }) },
    cbtExam: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    room: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: "room-2", name: "Small Room", capacity: opts.roomCapacity ?? 5 }),
    },
  };
  const svc = Object.create(ExamService.prototype) as ExamService;
  Object.assign(svc as unknown as Record<string, unknown>, {
    db: { runAsTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) },
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    log: jest.fn().mockResolvedValue(undefined),
    ctx: () => ({ schoolId: "sch-1", userId: "staff-1" }),
    assertClass: jest.fn().mockResolvedValue(undefined),
    assertNoHallClash: jest.fn().mockResolvedValue(undefined),
    dateOnly: (d: Date) => d.toISOString().slice(0, 10),
  });
  return { svc, update, tx };
}

const P = { schoolId: "sch-1", userId: "staff-1" } as never;
const patch = (svc: ExamService, body: Record<string, unknown>) =>
  (svc as unknown as { updateSitting: (p: unknown, id: string, b: unknown) => Promise<unknown> })
    .updateSitting(P, "sit-1", body);

describe("a hall that shrank under its candidates", () => {
  it("refuses a capacity below the candidates already seated", async () => {
    const { svc, update } = makeService({ capacity: 60, seated: 59 });
    await expect(patch(svc, { capacity: 5 })).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it("names both numbers and the way out", async () => {
    const { svc } = makeService({ capacity: 60, seated: 59 });
    await expect(patch(svc, { capacity: 5 })).rejects.toThrow(/59 candidate\(s\) are already seated/);
    await expect(patch(svc, { capacity: 5 })).rejects.toThrow(/cannot be set to 5 seat\(s\)/);
    await expect(patch(svc, { capacity: 5 })).rejects.toThrow(/Re-seat or move them first/);
  });

  it("refuses a MOVE to a smaller room, not just a typed capacity", async () => {
    // The realistic operator action, and the one a capacity-only check misses:
    // resolving the new room supplies its capacity.
    const { svc, update } = makeService({ capacity: 60, seated: 59, roomCapacity: 10 });
    await expect(patch(svc, { roomId: "room-2" })).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it("allows a capacity that exactly fits", async () => {
    const { svc, update } = makeService({ capacity: 60, seated: 59 });
    await patch(svc, { capacity: 59 });
    expect(update).toHaveBeenCalled();
  });

  it("treats zero as no limit, exactly as seating does", async () => {
    const { svc, update } = makeService({ capacity: 60, seated: 59 });
    await patch(svc, { capacity: 0 });
    expect(update).toHaveBeenCalled();
  });

  it("still allows a non-venue edit to an ALREADY over-capacity sitting", async () => {
    // The one way this guard could do harm. The exam-day board exists to surface
    // sittings that predate the check, so those rows are expected to exist —
    // and a guard that refused to rename or re-time them would freeze exactly
    // the records somebody is trying to put right.
    const { svc, update } = makeService({ capacity: 5, seated: 59 });
    await patch(svc, { title: "Renamed" });
    expect(update).toHaveBeenCalled();
  });
});
