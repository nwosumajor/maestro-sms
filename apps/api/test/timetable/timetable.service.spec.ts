// =============================================================================
// TimetableService — conflict detection + scoping (in-memory fakes, no DB)
// =============================================================================

import { TimetableService } from "../../src/timetable/timetable.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

interface Fakes {
  /** What timetableEntry.findFirst returns for the conflict probes, in order. */
  conflicts?: ({ id: string } | null)[];
  classRow?: { id: string } | null;
  enrollment?: { classId: string }[];
  classTeacher?: { id: string } | null;
}

function makeService(f: Fakes) {
  const conflicts = [...(f.conflicts ?? [])];
  const entryFindFirst = jest.fn(() => Promise.resolve(conflicts.shift() ?? null));
  const tx = {
    class: { findFirst: jest.fn().mockResolvedValue(f.classRow ?? { id: "c-1" }) },
    period: { findFirst: jest.fn().mockResolvedValue({ id: "per-1" }) },
    room: { findFirst: jest.fn().mockResolvedValue({ id: "room-1" }) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "t-1" }) },
    enrollment: { findMany: jest.fn().mockResolvedValue(f.enrollment ?? []) },
    parentChild: { findMany: jest.fn().mockResolvedValue([]) },
    classTeacher: { findFirst: jest.fn().mockResolvedValue(f.classTeacher ?? null), findMany: jest.fn().mockResolvedValue([]) },
    timetableEntry: {
      findFirst: entryFindFirst,
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "entry-1" }),
    },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new TimetableService(db as never, audit as never);
  return { service, tx };
}

const principal = (roles: string[], userId = "u-1"): Principal => ({
  schoolId: "school-A",
  userId,
  roles,
  permissions: [],
});

const entry = {
  classId: "c-1",
  dayOfWeek: "MONDAY" as const,
  periodId: "per-1",
  subject: "History",
  teacherId: "t-1",
  roomId: "room-1",
};

describe("TimetableService conflict detection", () => {
  it("creates an entry when there is no clash", async () => {
    // class probe, teacher probe, room probe all null
    const { service, tx } = makeService({ conflicts: [null, null, null] });
    await service.createEntry(principal(["school_admin"]), entry);
    expect(tx.timetableEntry.create as jest.Mock).toHaveBeenCalled();
  });

  it("rejects a CLASS double-booking (409)", async () => {
    const { service } = makeService({ conflicts: [{ id: "other" }] }); // class probe hits
    await expect(service.createEntry(principal(["school_admin"]), entry)).rejects.toThrow(/class already/i);
  });

  it("rejects a TEACHER double-booking (409)", async () => {
    const { service } = makeService({ conflicts: [null, { id: "other" }] }); // teacher probe hits
    await expect(service.createEntry(principal(["school_admin"]), entry)).rejects.toThrow(/teacher is already/i);
  });

  it("rejects a ROOM double-booking (409)", async () => {
    const { service } = makeService({ conflicts: [null, null, { id: "other" }] }); // room probe hits
    await expect(service.createEntry(principal(["school_admin"]), entry)).rejects.toThrow(/room is already/i);
  });

  it("rejects invalid period times", async () => {
    const { service } = makeService({});
    await expect(
      service.createPeriod(principal(["school_admin"]), { name: "P1", sequence: 1, startTime: "09:00", endTime: "08:00" }),
    ).rejects.toThrow(/before/i);
  });
});

describe("TimetableService scoping", () => {
  it("a student can view a class they are enrolled in", async () => {
    const { service, tx } = makeService({ classRow: { id: "c-1" }, enrollment: [{ classId: "c-1" }] });
    await service.getClassTimetable(principal(["student"]), "c-1");
    expect(tx.timetableEntry.findMany as jest.Mock).toHaveBeenCalled();
  });

  it("a student cannot view a class they are not in (404)", async () => {
    const { service } = makeService({ classRow: { id: "c-1" }, enrollment: [{ classId: "other" }] });
    await expect(service.getClassTimetable(principal(["student"]), "c-1")).rejects.toThrow(/not found/i);
  });
});
