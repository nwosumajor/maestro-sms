// =============================================================================
// 1,220 appointments still to come, and a head who could see none of them
// =============================================================================
// `mySlots` and `myBookings` both read `orderBy startsAt ASC` under a cap, with
// NO date filter — so they returned the OLDEST rows ever recorded and the cap
// discarded the future. A diary read to answer "what is next" answered "what
// was first".
//
// Measured against the running stack on a 61-teacher secondary three years in
// (10,980 slots, 1,220 of them still to come):
//
//     school-wide reader   returned 200   range 2023-11-12 .. 2023-11-12   upcoming visible 0
//     teacher, 4 yrs       returned 200   range 2022-11-12 .. 2026-03-12   upcoming visible 0
//     parent's bookings    returned  11   FIRST row 2022-11-12, next month's LAST
//
// The school-wide range is a single day three years earlier: that screen would
// never advance, because every new slot sorts after the 200 oldest.
//
// This is the mirror of the newest-first cap this repo records against a
// register. There the cap eats the oldest row and a register exists to surface
// the oldest; here the cap eats the newest and a diary exists to surface what
// is next. The rule is the same: ORDER SO THE CAP KEEPS WHAT THE SCREEN IS FOR.
//
// The correct sibling was one method away the whole time. `listOpenSlots`
// filters `startsAt >= now`, pages, and carries a long comment reasoning about
// exactly this failure for the parent's booking list. It was never swept to the
// host's own list or to the parent's own bookings — three doors, one guarded.
//
// `myBookings` went further and SAID it was right: its docstring read
// "(BOOKED, future first)" over a query with no date filter at all.
// =============================================================================

import { MeetingService } from "../../src/meeting/meeting.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const DAY = 86_400_000;
const now = Date.now();

const head: Principal = {
  schoolId: "A", userId: "head", roles: ["principal"],
  permissions: ["meeting.host", "meeting.book"],
};
const parent: Principal = {
  schoolId: "A", userId: "p1", roles: ["parent"], permissions: ["meeting.book"],
};

/** Nine parents' evenings: eight behind, one ahead. */
const SLOTS = Array.from({ length: 9 }, (_, ev) =>
  Array.from({ length: 20 }, (_, n) => ({
    id: `s-${ev}-${n}`,
    teacherId: `t${ev % 3}`,
    startsAt: new Date(now + (ev === 8 ? 30 : -(34 - ev * 4) * 30) * DAY + n * 900_000),
    endsAt: new Date(now + (ev === 8 ? 30 : -(34 - ev * 4) * 30) * DAY + n * 900_000 + 900_000),
    capacity: 1, location: "Hall", note: null, active: true,
    provider: null, joinUrl: null, audienceKind: "SCHOOL", audienceRef: null, kind: "APPOINTMENT",
  })),
).flat();

const BOOKINGS = SLOTS.filter((_, i) => i % 20 === 0).map((s, i) => ({
  id: `b${i}`, slotId: s.id, parentId: "p1", studentId: "stu1", status: "BOOKED",
  note: null, slot: { startsAt: s.startsAt, teacherId: s.teacherId, location: s.location },
}));

type W = { gte?: Date; lt?: Date } | undefined;
const inWindow = (d: Date, w: W) => !((w?.gte && d < w.gte) || (w?.lt && d >= w.lt));

function makeService() {
  // A double must model the CONTRACT: `count` draws from the SAME predicate as
  // `findMany`, or a total is vouched for that does not describe the page.
  const slotsWhere = (where: Record<string, unknown> = {}) =>
    SLOTS.filter((s) => inWindow(s.startsAt, where.startsAt as W));
  // Honours BOTH filters this model is asked for: the diary window, and the
  // `slotId in [...]` that `bookingsForHost` uses to fetch a host's attendees.
  // A double that ignores the second returns every booking for every slot.
  const bookingsWhere = (where: Record<string, unknown> = {}) => {
    const ids = (where.slotId as { in?: string[] } | undefined)?.in;
    return BOOKINGS.filter(
      (b) =>
        inWindow(b.slot.startsAt, (where.slot as { startsAt?: W })?.startsAt) &&
        (ids ? ids.includes(b.slotId) : true),
    );
  };

  // `orderBy` is absent on some real calls; treating undefined as "desc" would
  // silently reorder them.
  const dir = (o: unknown): "asc" | "desc" =>
    o !== undefined && JSON.stringify(o).includes('"desc"') ? "desc" : "asc";

  const tx = {
    meetingSlot: {
      findMany: jest.fn(async ({ where, orderBy, take }: Record<string, never>) => {
        const rows = [...slotsWhere(where)].sort((a, b) =>
          dir(orderBy) === "desc"
            ? b.startsAt.getTime() - a.startsAt.getTime()
            : a.startsAt.getTime() - b.startsAt.getTime());
        return take ? rows.slice(0, take as number) : rows;
      }),
      count: jest.fn(async ({ where }: Record<string, never>) => slotsWhere(where).length),
    },
    meetingBooking: {
      findMany: jest.fn(async ({ where, orderBy, take }: Record<string, never>) => {
        const rows = [...bookingsWhere(where)].sort((a, b) =>
          dir(orderBy) === "desc"
            ? b.slot.startsAt.getTime() - a.slot.startsAt.getTime()
            : a.slot.startsAt.getTime() - b.slot.startsAt.getTime());
        return take ? rows.slice(0, take as number) : rows;
      }),
      count: jest.fn(async ({ where }: Record<string, never>) => bookingsWhere(where).length),
      groupBy: jest.fn(async () => []),
    },
    meetingCohost: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => []) },
    classSubjectTeacher: { findMany: jest.fn(async () => []) },
    class: { findMany: jest.fn(async () => []) },
    school: { findFirst: jest.fn(async () => ({ country: null, timezone: null })) },
  } as unknown as TenantTx;

  return new MeetingService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn(), notifyPermissionHolders: jest.fn() } as never,
    { forSchool: jest.fn(async () => ({ timezone: "Africa/Lagos", compliance: "NDPR" })), inTx: jest.fn(async () => ({ timezone: "Africa/Lagos" })) } as never,
  );
}

describe("a host's diary answers what is NEXT", () => {
  it("shows the upcoming evening, not the first one ever held", async () => {
    const r = await makeService().mySlots(head);
    expect(r.items.length).toBeGreaterThan(0);
    // The property, not a date: every row returned is still to come.
    for (const s of r.items) expect(new Date(s.startsAt).getTime()).toBeGreaterThan(now - DAY);
  });

  it("counts the upcoming rows in the DATABASE, over the page's own predicate", async () => {
    const r = await makeService().mySlots(head);
    expect(r.total).toBe(20);
    expect(r.shown).toBe(r.items.length);
  });

  it("says how much history it is NOT showing", async () => {
    // A capped list that says nothing reads as a complete one.
    const r = await makeService().mySlots(head);
    expect(r.otherTotal).toBe(160);
  });

  it("reaches the history, most recent first", async () => {
    const r = await makeService().mySlots(head, "past");
    expect(r.total).toBe(160);
    const ds = r.items.map((s) => new Date(s.startsAt).getTime());
    expect([...ds].sort((a, b) => b - a)).toEqual(ds);
    for (const d of ds) expect(d).toBeLessThan(now);
  });
});

describe("a parent's bookings do what the docstring always claimed", () => {
  it("puts the next meeting first, not one from four years ago", async () => {
    const r = await makeService().myBookings(parent);
    expect(r.items.length).toBeGreaterThan(0);
    for (const b of r.items) expect(new Date(b.startsAt).getTime()).toBeGreaterThan(now - DAY);
  });

  it("still keeps the past reachable rather than dropping it", async () => {
    const r = await makeService().myBookings(parent, "past");
    expect(r.total).toBeGreaterThan(0);
    expect(r.items.every((b) => new Date(b.startsAt).getTime() < now)).toBe(true);
  });

  it("the two ends partition the whole diary — nothing is stranded between them", async () => {
    const up = await makeService().myBookings(parent);
    const past = await makeService().myBookings(parent, "past");
    expect(up.total + past.total).toBe(BOOKINGS.length);
    expect(up.otherTotal).toBe(past.total);
  });
});
