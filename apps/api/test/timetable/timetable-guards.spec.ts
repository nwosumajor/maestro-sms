// =============================================================================
// Timetable — the guards a live probe found missing
// =============================================================================
// Each test here corresponds to something the running API actually did wrong:
//
//   - a partial PATCH stored a period running 23:00-09:00, because the time
//     check only fired when BOTH times were in the payload;
//   - two periods could overlap (08:00-09:00 and 08:30-09:30 both accepted);
//   - a duplicate period sequence and a duplicate room name each returned 500,
//     because the unique constraints existed but P2002 was never translated;
//   - 12 concurrent bookings of one teacher slot let 2 through, both 201;
//   - periods and rooms had no delete route at all.
//
// The period fake EVALUATES the overlap predicate rather than returning a fixed
// row. Overlap is a filter, and a mock that answers the same way regardless of
// the `where` would keep these green after the filter is deleted.
// =============================================================================

import { ConflictException, BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { TimetableService } from "../../src/timetable/timetable.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const admin = { userId: "u1", schoolId: "s1", roles: ["school_admin"], permissions: [] } as unknown as Principal;

type PeriodRow = { id: string; name: string; sequence: number; startTime: string; endTime: string };

function harness(opts: {
  periods?: PeriodRow[];
  lessonsInPeriod?: number;
  lessonsInRoom?: number;
  offeringsPreferringRoom?: number;
  createRejects?: boolean;
} = {}) {
  const periods = opts.periods ?? [];
  const deleted: string[] = [];

  const overlapping = (where: Record<string, unknown>) => {
    const start = (where.endTime as { gt?: string })?.gt;
    const end = (where.startTime as { lt?: string })?.lt;
    const notId = (where.id as { not?: string })?.not;
    if (start === undefined || end === undefined) {
      // Not the overlap probe — an id lookup.
      return periods.find((p) => p.id === where.id) ?? null;
    }
    return periods.find((p) => p.id !== notId && p.startTime < end && p.endTime > start) ?? null;
  };

  // Shaped like what the RUNNING database actually sends. Postgres reports
  // "Unique constraint failed on the (not available)" here with meta.target
  // ABSENT — an earlier version of this fixture supplied a column list, which
  // made a target-matching translator look correct while it never once matched
  // in production. If a fixture is more informative than the real thing, it is
  // testing a mechanism that does not exist.
  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the (not available)", {
      code: "P2002",
      clientVersion: "x",
    });

  const maybeReject = () => (opts.createRejects ? Promise.reject(p2002()) : Promise.resolve({ id: "new" }));

  const tx = {
    period: {
      findFirst: jest.fn((args: { where: Record<string, unknown> }) => Promise.resolve(overlapping(args.where))),
      findMany: jest.fn().mockResolvedValue(periods),
      create: jest.fn(() => maybeReject()),
      update: jest.fn(() => maybeReject()),
      delete: jest.fn((args: { where: { id: string } }) => {
        deleted.push(args.where.id);
        return Promise.resolve({ id: args.where.id });
      }),
      count: jest.fn().mockResolvedValue(0),
    },
    room: {
      findFirst: jest.fn().mockResolvedValue({ id: "r1", name: "Lab 1" }),
      create: jest.fn(() => maybeReject()),
      update: jest.fn(() => maybeReject()),
      delete: jest.fn((args: { where: { id: string } }) => {
        deleted.push(args.where.id);
        return Promise.resolve({ id: args.where.id });
      }),
    },
    timetableEntry: {
      // No pre-existing clash, so createEntry reaches the INSERT — which is the
      // only place the race can be lost and therefore the only place the
      // constraint speaks.
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn((args?: { where?: Record<string, unknown> }) =>
        Promise.resolve(args?.where?.roomId ? (opts.lessonsInRoom ?? 0) : (opts.lessonsInPeriod ?? 0)),
      ),
      create: jest.fn(() => maybeReject()),
    },
    classSubjectTeacher: { count: jest.fn().mockResolvedValue(opts.offeringsPreferringRoom ?? 0) },
    teacherUnavailability: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    subject: { findFirst: jest.fn().mockResolvedValue({ id: "sub1", name: "History" }) },
    class: { findFirst: jest.fn().mockResolvedValue({ id: "c1" }) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "t1" }) },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = new TimetableService(db as never, { record: jest.fn().mockResolvedValue(undefined) } as never);
  return { svc, tx, deleted };
}

const DAY = [
  { id: "p1", name: "Period 1", sequence: 1, startTime: "08:00", endTime: "09:00" },
  { id: "p2", name: "Period 2", sequence: 2, startTime: "09:00", endTime: "10:00" },
];

describe("period times survive a PARTIAL update", () => {
  it("rejects a start moved past the existing end", async () => {
    // Live, `PATCH {startTime:"23:00"}` on an 08:00-09:00 period returned 200
    // and stored 23:00-09:00. The check ran only when BOTH times were sent.
    const { svc } = harness({ periods: DAY });
    await expect(svc.updatePeriod(admin, "p1", { startTime: "23:00" })).rejects.toThrow(BadRequestException);
  });

  it("rejects an end moved before the existing start", async () => {
    const { svc } = harness({ periods: DAY });
    await expect(svc.updatePeriod(admin, "p2", { endTime: "07:00" })).rejects.toThrow(BadRequestException);
  });

  it("still allows a legitimate one-sided edit", async () => {
    // The guard must not make ordinary edits impossible: 08:00-09:00 -> ends
    // 08:45 is fine and must not trip the overlap check against ITSELF.
    const { svc } = harness({ periods: DAY });
    await expect(svc.updatePeriod(admin, "p1", { endTime: "08:45" })).resolves.toBeDefined();
  });
});

describe("periods cannot run at the same time", () => {
  it("refuses an overlapping period", async () => {
    const { svc } = harness({ periods: DAY });
    await expect(
      svc.createPeriod(admin, { name: "Extra", sequence: 3, startTime: "08:30", endTime: "09:30" }),
    ).rejects.toThrow(/overlaps Period 1/);
  });

  it("allows back-to-back periods", async () => {
    // Half-open: ending 10:00 and starting 10:00 is the normal case, not a clash.
    const { svc } = harness({ periods: DAY });
    await expect(
      svc.createPeriod(admin, { name: "Period 3", sequence: 3, startTime: "10:00", endTime: "11:00" }),
    ).resolves.toBeDefined();
  });
});

describe("a unique violation reads as the clash it is, not a 500", () => {
  it("a lost race on a lesson slot -> 409, and says the slot went", async () => {
    // The pre-check passed, so this IS the race. The message must not claim to
    // know whether it was the class, the teacher or the room — the transaction
    // is aborted and nothing can be re-read to find out.
    const { svc } = harness({ periods: DAY, createRejects: true });
    await expect(
      svc.createEntry(admin, {
        classId: "c1",
        dayOfWeek: "MONDAY",
        periodId: "p1",
        subjectId: "sub1",
        teacherId: "t1",
        roomId: "r1",
      }),
    ).rejects.toThrow(/taken while you were saving/);
  });

  it("duplicate period sequence -> 409", async () => {
    const { svc } = harness({ createRejects: true });
    await expect(
      svc.createPeriod(admin, { name: "Dup", sequence: 1, startTime: "14:00", endTime: "15:00" }),
    ).rejects.toThrow(/already uses that position/);
  });

  it("duplicate room name -> 409", async () => {
    const { svc } = harness({ createRejects: true });
    await expect(svc.createRoom(admin, { name: "Lab 1" })).rejects.toThrow(/room with that name already exists/);
  });

  it("an unrelated error is NOT swallowed", async () => {
    // The translator must rethrow anything it does not recognise, or a real
    // fault becomes a misleading 409 about double-booking.
    const { svc, tx } = harness();
    (tx.room.create as jest.Mock).mockRejectedValueOnce(new Error("connection reset"));
    await expect(svc.createRoom(admin, { name: "Lab 2" })).rejects.toThrow("connection reset");
  });
});

describe("deleting a period or room names what blocks it", () => {
  it("refuses a period with lessons in it, with the count", async () => {
    const { svc, deleted } = harness({ periods: DAY, lessonsInPeriod: 3 });
    await expect(svc.deletePeriod(admin, "p1")).rejects.toThrow(/3 lessons are scheduled in Period 1/);
    expect(deleted).toHaveLength(0);
  });

  it("deletes a free period, and its availability marks with it", async () => {
    const { svc, tx, deleted } = harness({ periods: DAY, lessonsInPeriod: 0 });
    await svc.deletePeriod(admin, "p1");
    expect(deleted).toEqual(["p1"]);
    expect(tx.teacherUnavailability.deleteMany).toHaveBeenCalledWith({ where: { periodId: "p1" } });
  });

  it("refuses a room with lessons in it", async () => {
    const { svc, deleted } = harness({ lessonsInRoom: 2 });
    await expect(svc.deleteRoom(admin, "r1")).rejects.toThrow(/2 lessons are scheduled in Lab 1/);
    expect(deleted).toHaveLength(0);
  });

  it("refuses a room an offering still prefers", async () => {
    // A soft solver constraint pointing at a deleted room is a dangling
    // reference the generator would read every run.
    const { svc } = harness({ lessonsInRoom: 0, offeringsPreferringRoom: 1 });
    await expect(svc.deleteRoom(admin, "r1")).rejects.toThrow(/1 subject offering prefers Lab 1/);
  });

  it("404s on a period that is not there", async () => {
    const { svc } = harness({ periods: [] });
    await expect(svc.deletePeriod(admin, "nope")).rejects.toThrow(NotFoundException);
  });
});

describe("the pre-check still does the ordinary-case work", () => {
  it("names the specific clash BEFORE any insert is attempted", async () => {
    // Both layers earn their place: the pre-check gives a precise, ordered
    // message for the normal single-request case; the constraint is the
    // backstop for the race, where a precise message is not obtainable.
    const { svc, tx } = harness({ periods: DAY });
    (tx.timetableEntry.findFirst as jest.Mock).mockResolvedValueOnce({ id: "existing" });
    await expect(
      svc.createEntry(admin, {
        classId: "c1",
        dayOfWeek: "MONDAY",
        periodId: "p1",
        subjectId: "sub1",
        teacherId: "t1",
        roomId: "r1",
      }),
    ).rejects.toThrow(/class already has a lesson/);
    expect(tx.timetableEntry.create).not.toHaveBeenCalled();
  });
});
