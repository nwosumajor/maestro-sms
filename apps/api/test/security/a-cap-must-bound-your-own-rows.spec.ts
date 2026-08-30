// =============================================================================
// A limit must bound the rows you may SEE, not the rows that exist
// =============================================================================
// The same defect that stopped a school charging late fees, in its read-only
// form. A list fetches `take: N` rows across the whole school and then keeps
// the caller's own — so the limit is spent on other people's records, and a
// user whose rows sort past the cap sees an EMPTY screen with no explanation.
// It fails silently, it fails worse the busier the school gets, and it looks
// exactly like "you have nothing to do".
//
//   - the SIS profile review queue read the 500 OLDEST submitted profiles in
//     the school, then kept those belonging to classes the caller supervises.
//     A term start submits far more than 500 at once, so a supervisor whose
//     class submitted late saw nothing at all while their reviews waited.
//   - the syllabus list read the 500 most RECENTLY UPDATED plans in the school
//     and then kept the caller's own — so a teacher whose plan had not been
//     touched lately saw nothing, and the more active their colleagues, the
//     emptier their own screen.
//
// Both now express the relationship in the WHERE clause, so the cap bounds the
// caller's own rows. Prisma treats `OR: []` as match-nothing, verified against
// the running database (0 of 4 rows) — so a teacher who teaches nothing still
// sees nothing rather than everything.
// =============================================================================

import { SisService } from "../../src/sis/sis.service";
import { SyllabusService } from "../../src/lms/syllabus.service";

const CAP = 500;

/** A tenant-db stub whose findMany HONOURS the where it is given, so a service
 *  that fails to narrow the query really does drown in other people's rows. */
function tenantDb(tables: Record<string, unknown[]>) {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (k === "OR") return (v as Array<Record<string, unknown>>).some((c) => matches(row, c));
      if (v && typeof v === "object" && "in" in (v as object)) {
        return ((v as { in: unknown[] }).in ?? []).includes(row[k]);
      }
      if (v && typeof v === "object" && "not" in (v as object)) {
        return row[k] !== (v as { not: unknown }).not;
      }
      if (v && typeof v === "object") return true; // nested relation filters: not modelled
      return row[k] === v;
    });

  const model = (name: string) => ({
    findMany: (args: { where?: Record<string, unknown>; take?: number } = {}) =>
      Promise.resolve((tables[name] ?? []).filter((r) => matches(r as Record<string, unknown>, args.where ?? {})).slice(0, args.take ?? Infinity)),
    groupBy: () => Promise.resolve([]),
    count: () => Promise.resolve(0),
  });

  const tx = new Proxy({}, { get: (_t, name: string) => model(name) });
  return {
    runAsTenantReadOnly: (_c: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    runAsTenant: (_c: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as never;
}

describe("the SIS profile review queue", () => {
  const supervisor = {
    userId: "sup-1",
    schoolId: "school-1",
    roles: ["teacher"],
    permissions: ["student.profile.review"],
  } as never;

  it("shows a supervisor their own pupils even when 500 others queued first", async () => {
    // 500 profiles from other classes, submitted EARLIEST, then one of mine.
    const studentProfile = [
      ...Array.from({ length: CAP }, (_, i) => ({
        studentId: `other-${i}`,
        profileStatus: "SUBMITTED",
        submittedAt: new Date(2026, 0, 1),
        supervisorReviewedAt: null,
      })),
      { studentId: "mine-1", profileStatus: "SUBMITTED", submittedAt: new Date(2026, 5, 1), supervisorReviewedAt: null },
    ];
    const db = tenantDb({
      studentProfile,
      // Only "mine-1" sits in a class this person supervises.
      enrollment: [{ studentId: "mine-1", status: "ACTIVE", class: { name: "JSS1" } }],
      user: [{ id: "mine-1", name: "A Pupil" }],
    });
    const rows = await new SisService(db, { record: jest.fn() } as never, { enqueue: jest.fn() } as never)
      .profileReviewQueue(supervisor);
    expect(rows.map((r) => r.studentId)).toEqual(["mine-1"]);
  });

  it("still shows an approver rows past supervisor stage, for pupils they do not supervise", async () => {
    // The narrowing has two branches and the live database exercises neither
    // (no class has a supervisor, and nothing has reached the office yet), so
    // this is where that half is proved. Someone holding rbac.manage without a
    // school-wide role reviews the OFFICE stage for any pupil, and their own
    // class at the supervisor stage.
    const db = tenantDb({
      studentProfile: [
        { studentId: "passed-up", profileStatus: "SUBMITTED", submittedAt: new Date(2026, 0, 1), supervisorReviewedAt: new Date(2026, 0, 2) },
        { studentId: "someone-elses", profileStatus: "SUBMITTED", submittedAt: new Date(2026, 0, 1), supervisorReviewedAt: null },
      ],
      enrollment: [],
      user: [{ id: "passed-up", name: "A Pupil" }],
    });
    const approver = { ...(supervisor as object), permissions: ["student.profile.review", "rbac.manage"] } as never;
    const rows = await new SisService(db, { record: jest.fn() } as never, { enqueue: jest.fn() } as never)
      .profileReviewQueue(approver);
    expect(rows.map((r) => r.studentId)).toEqual(["passed-up"]);
    expect(rows[0].stage).toBe("ADMIN");
  });

  it("shows a supervisor nothing when they supervise nobody", async () => {
    const db = tenantDb({
      studentProfile: [{ studentId: "other-1", profileStatus: "SUBMITTED", submittedAt: new Date(), supervisorReviewedAt: null }],
      enrollment: [],
      user: [],
    });
    const rows = await new SisService(db, { record: jest.fn() } as never, { enqueue: jest.fn() } as never)
      .profileReviewQueue(supervisor);
    expect(rows).toEqual([]);
  });
});

describe("the syllabus list for a term", () => {
  const teacher = { userId: "t-1", schoolId: "school-1", roles: ["teacher"], permissions: [] } as never;

  it("shows a teacher their own plan even when 500 fresher ones exist", async () => {
    const subjectSyllabus = [
      ...Array.from({ length: CAP }, (_, i) => ({
        id: `s-${i}`,
        classId: `c-${i}`,
        subjectId: `sub-${i}`,
        termId: "term-1",
        ownerId: "someone",
        updatedAt: new Date(2026, 6, 1),
      })),
      { id: "mine", classId: "c-mine", subjectId: "sub-mine", termId: "term-1", ownerId: "t-1", updatedAt: new Date(2026, 0, 1) },
    ];
    const db = tenantDb({
      subjectSyllabus,
      classSubjectTeacher: [{ teacherId: "t-1", classId: "c-mine", subjectId: "sub-mine" }],
      class: [{ id: "c-mine", name: "JSS1" }],
      subject: [{ id: "sub-mine", name: "Maths" }],
      user: [{ id: "t-1", name: "A Teacher" }],
    });
    const rows = (await new SyllabusService(db, { record: jest.fn() } as never).listForTerm(teacher, "term-1")) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["mine"]);
  });

  it("shows nothing to a teacher who teaches nothing", async () => {
    // Prisma reads OR: [] as match-nothing — checked against the real database,
    // because the opposite reading would show one teacher every plan in the school.
    const db = tenantDb({
      subjectSyllabus: [{ id: "s-1", classId: "c-1", subjectId: "sub-1", termId: "term-1", ownerId: "x", updatedAt: new Date() }],
      classSubjectTeacher: [],
    });
    const rows = (await new SyllabusService(db, { record: jest.fn() } as never).listForTerm(teacher, "term-1")) as unknown[];
    expect(rows).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// The variant Prisma cannot express in a WHERE
// -----------------------------------------------------------------------------
// Open meeting slots are the same defect with no query-level fix available: a
// slot is full when its BOOKINGS reach capacity, and bookings are rows, not a
// column, so the fullness test can only run after the fetch. Reading the first
// 200 and discarding the full ones told a parent "no times available" while
// later slots stood open — and the earliest slots fill first, so the busier the
// evening the more of the list was already gone. The page is refilled instead.
// -----------------------------------------------------------------------------

import { MeetingService } from "../../src/meeting/meeting.service";

describe("open meeting slots", () => {
  const parent = { userId: "p-1", schoolId: "school-1", roles: ["parent"], permissions: ["meeting.book"] } as never;

  function meetingDb(slotCount: number, openFrom: number) {
    const all = Array.from({ length: slotCount }, (_, i) => ({
      id: `slot-${i}`,
      teacherId: "t-1",
      capacity: 1,
      audienceKind: "SCHOOL",
      audienceRef: null,
      startsAt: new Date(2026, 8, 1, 9, i),
      endsAt: new Date(2026, 8, 1, 9, i + 1),
      active: true,
    }));
    const pages: number[] = [];
    const tx = {
      // A parent with one child, so the audience filter matches SCHOOL slots.
      parentChild: { findMany: () => Promise.resolve([{ studentId: "kid-1" }]) },
      enrollment: { findMany: () => Promise.resolve([]) },
      meetingInvitee: { findMany: () => Promise.resolve([]) },
      meetingSlot: {
        findMany: ({ take, skip }: { take: number; skip?: number }) => {
          pages.push(skip ?? 0);
          return Promise.resolve(all.slice(skip ?? 0, (skip ?? 0) + take));
        },
      },
      // Everything before `openFrom` is fully booked.
      meetingBooking: {
        groupBy: () =>
          Promise.resolve(
            all.slice(0, openFrom).map((s) => ({ slotId: s.id, _count: { _all: 1 } })),
          ),
        findMany: () =>
          Promise.resolve(all.slice(0, openFrom).map((s) => ({ slotId: s.id, id: `b-${s.id}` }))),
      },
      meetingCohost: { findMany: () => Promise.resolve([]) },
      user: { findMany: () => Promise.resolve([{ id: "t-1", name: "A Teacher" }]) },
      classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
      class: { findMany: () => Promise.resolve([]) },
      student: { findMany: () => Promise.resolve([]) },
    };
    const db = {
      runAsTenantReadOnly: (_c: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
      runAsTenant: (_c: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    } as never;
    return { db, pages };
  }

  it("finds the open slots that sit past the first page of full ones", async () => {
    // 260 slots, the first 200 all taken — precisely the shape that returned an
    // empty list while 60 times stood open.
    const { db, pages } = meetingDb(260, 200);
    const svc = new MeetingService(db, { record: jest.fn() } as never, { enqueue: jest.fn() } as never);
    const rows = (await svc.openSlots(parent)) as Array<{ id: string }>;
    expect(rows.length).toBe(60);
    expect(rows[0].id).toBe("slot-200");
    // It had to look past the first page to find them.
    expect(pages.length).toBeGreaterThan(1);
  });

  it("stops once the source is exhausted rather than paging for ever", async () => {
    const { db, pages } = meetingDb(10, 10); // every slot full
    const svc = new MeetingService(db, { record: jest.fn() } as never, { enqueue: jest.fn() } as never);
    const rows = (await svc.openSlots(parent)) as unknown[];
    expect(rows).toEqual([]);
    expect(pages.length).toBe(1);
  });
});
