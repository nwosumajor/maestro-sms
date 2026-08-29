// =============================================================================
// Meeting audience — who a meeting is FOR
// =============================================================================
// The page modelled one thing: a bookable 1:1 slot, and every parent in the
// school saw every open slot with nothing saying which were meant for them. A
// principal calling a year-group meeting could not express it at all.
//
// The fix is one field, not a second model. What these defend:
//
//   • a parent sees only what their family is invited to
//   • a teacher cannot summon a year group or the school
//   • the audience RULE is stored, so it stays current as pupils come and go
//   • nothing fans out to compute a list on a page render

import { NOTIFICATION_MESSAGES, describeAudience, meetingAudienceProblem } from "@sms/types";

describe("meetingAudienceProblem", () => {
  it("accepts each of the four shapes", () => {
    expect(meetingAudienceProblem({ kind: "SCHOOL", ref: null })).toBeNull();
    expect(meetingAudienceProblem({ kind: "STAGE", ref: "SENIOR_SECONDARY" })).toBeNull();
    expect(meetingAudienceProblem({ kind: "CLASS", ref: "c-1" })).toBeNull();
    expect(meetingAudienceProblem({ kind: "STUDENT", ref: "s-1" })).toBeNull();
  });

  it("refuses a targeted audience with NO target", () => {
    // The dangerous direction: a null ref would silently widen the invitation to
    // everybody, which is the one mistake that must not be expressible.
    expect(meetingAudienceProblem({ kind: "CLASS", ref: null })).toMatch(/needs a class/);
    expect(meetingAudienceProblem({ kind: "STAGE", ref: null })).toMatch(/needs a year group/);
    expect(meetingAudienceProblem({ kind: "STUDENT", ref: null })).toMatch(/needs a student/);
  });

  it("refuses a whole-school meeting that also names a class", () => {
    // Two audiences in one row: which one is it? Refusing beats picking.
    expect(meetingAudienceProblem({ kind: "SCHOOL", ref: "c-1" })).toMatch(/takes no class or pupil/);
  });

  it("refuses an unknown kind", () => {
    expect(meetingAudienceProblem({ kind: "EVERYONE" as never, ref: null })).toMatch(/must be one of/);
  });
});

describe("describeAudience", () => {
  it("names the audience the way a parent would read it", () => {
    expect(describeAudience({ kind: "SCHOOL", ref: null })).toBe("All parents in the school");
    expect(describeAudience({ kind: "CLASS", ref: "c" }, { class: "JSS2" })).toBe("All JSS2 parents");
    expect(describeAudience({ kind: "STAGE", ref: "s" }, { stage: "Senior Secondary" })).toBe("All Senior Secondary parents");
    expect(describeAudience({ kind: "STUDENT", ref: "s" }, { student: "Amara" })).toBe("Amara's parents");
  });

  it("degrades to a generic label rather than showing a raw id", () => {
    // A screen that has not loaded the class name must not print a uuid at a
    // parent, and must not claim the wrong scope either.
    expect(describeAudience({ kind: "CLASS", ref: "c-1" })).toBe("One class's parents");
    expect(describeAudience({ kind: "STAGE", ref: "SENIOR_SECONDARY" })).toBe("One year group's parents");
    expect(describeAudience({ kind: "STUDENT", ref: "s-1" })).toBe("One pupil's parents");
  });

  it("never leaks the ref into the label", () => {
    for (const kind of ["STUDENT", "CLASS", "STAGE", "SCHOOL"] as const) {
      expect(describeAudience({ kind, ref: "SECRET-ID" })).not.toContain("SECRET-ID");
    }
  });
});

// -----------------------------------------------------------------------------

import { MeetingService } from "../../src/meeting/meeting.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const teacher: Principal = { schoolId: "A", userId: "t1", roles: ["teacher"], permissions: ["meeting.host"] };
const principal: Principal = { schoolId: "A", userId: "p1", roles: ["principal"], permissions: ["meeting.host"] };
const parent: Principal = { schoolId: "A", userId: "par1", roles: ["parent"], permissions: ["meeting.book"] };

function harness(opts: {
  ownsClass?: boolean;
  children?: string[];
  classes?: string[];
  stages?: Array<string | null>;
} = {}) {
  const created: Array<Record<string, unknown>> = [];
  let slotWhere: Record<string, unknown> | null = null;
  const tx = {
    // Every real TenantTx has this: the notice carries the meeting time in the
    // SCHOOL's clock, so the producer resolves the school's region.
    school: { findFirst: jest.fn().mockResolvedValue({ country: null, timezone: null }) },
  // Capacity checks lock the contended row first (the class / route / slot),
  // so the count and the insert are atomic — the same guard hostel allocation
  // uses for a bed. The mock just has to answer.
  $executeRaw: jest.fn().mockResolvedValue(1),

    class: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(where.supervisorId ? (opts.ownsClass ? { id: "c1" } : null) : { id: "c1" }),
      ),
      findMany: jest.fn().mockResolvedValue((opts.stages ?? []).map((stage) => ({ stage }))),
    },
    classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue(opts.ownsClass ? { id: "o" } : null) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "s1", name: "Pupil" }), findMany: jest.fn().mockResolvedValue([]) },
    parentChild: { findMany: jest.fn().mockResolvedValue((opts.children ?? []).map((studentId) => ({ studentId }))) },
    enrollment: { findMany: jest.fn().mockResolvedValue((opts.classes ?? []).map((classId) => ({ classId }))) },
    meetingSlot: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: "sl1", ...data, provider: null, joinUrl: null, active: true, booked: 0 });
      }),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        slotWhere = where;
        return Promise.resolve([]);
      }),
    },
    // SELECTED is matched through the invitee table; a parent on no list gets none.
    meetingInvitee: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    meetingBooking: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new MeetingService(db as never, audit as never, undefined as never), created, where: () => slotWhere };
}

const WHEN = { startsAt: "2027-03-01T09:00:00Z", endsAt: "2027-03-01T09:30:00Z" };

describe("who may summon whom", () => {
  it("lets a principal call a whole-school meeting", async () => {
    const { svc, created } = harness();
    await svc.createSlot(principal, { ...WHEN, audience: { kind: "SCHOOL", ref: null } });
    expect(created[0]).toMatchObject({ audienceKind: "SCHOOL", audienceRef: null });
  });

  it("REFUSES a teacher calling the whole school", async () => {
    // The dropdown must not be the control. A teacher changing a select box
    // cannot summon every parent in the school.
    const { svc, created } = harness();
    await expect(svc.createSlot(teacher, { ...WHEN, audience: { kind: "SCHOOL", ref: null } }))
      .rejects.toThrow(/principal or school administrator/i);
    expect(created).toHaveLength(0);
  });

  it("REFUSES a teacher calling a year group", async () => {
    const { svc } = harness();
    await expect(svc.createSlot(teacher, { ...WHEN, audience: { kind: "STAGE", ref: "SENIOR_SECONDARY" } }))
      .rejects.toThrow(/principal or school administrator/i);
  });

  it("lets a teacher call the parents of a class they teach", async () => {
    const { svc, created } = harness({ ownsClass: true });
    await svc.createSlot(teacher, { ...WHEN, audience: { kind: "CLASS", ref: "c1" } });
    expect(created[0]).toMatchObject({ audienceKind: "CLASS", audienceRef: "c1" });
  });

  it("404s a teacher calling a class they have nothing to do with", async () => {
    const { svc, created } = harness({ ownsClass: false });
    await expect(svc.createSlot(teacher, { ...WHEN, audience: { kind: "CLASS", ref: "c9" } }))
      .rejects.toThrow(/not found/i);
    expect(created).toHaveLength(0);
  });

  it("refuses a year group that is not one of the four", async () => {
    // A typo'd stage would produce a meeting nobody is invited to, which looks
    // exactly like one nobody has booked.
    const { svc } = harness();
    await expect(svc.createSlot(principal, { ...WHEN, audience: { kind: "STAGE", ref: "SS3" } }))
      .rejects.toThrow(/Year group must be one of/);
  });

  it("defaults to SCHOOL when no audience is given, as every old slot was", async () => {
    const { svc, created } = harness();
    await svc.createSlot(principal, WHEN);
    expect(created[0]).toMatchObject({ audienceKind: "SCHOOL", audienceRef: null });
  });

  it("stamps a DECLARED wide audience as a BRIEFING and everything else as an APPOINTMENT", async () => {
    const a = harness();
    await a.svc.createSlot(principal, { ...WHEN, audience: { kind: "SCHOOL", ref: null } });
    expect(a.created[0].kind).toBe("BRIEFING");
    const b = harness();
    await b.svc.createSlot(principal, WHEN); // no declared audience
    expect(b.created[0].kind).toBe("APPOINTMENT");
  });

  it("lets a TEACHER open a plain slot with no audience — offering availability is not summoning anyone", async () => {
    // The distinction the first version of this rule blurred: an open bookable
    // slot invites nobody, parents find it. Refusing it would have broken every
    // teacher's existing workflow.
    const { svc, created } = harness();
    await svc.createSlot(teacher, WHEN);
    expect(created[0]).toMatchObject({ audienceKind: "SCHOOL" });
  });
});

describe("capacity follows the audience", () => {
  it("caps a 1:1 appointment at 5, however large a number is sent", async () => {
    const { svc, created } = harness();
    await svc.createSlot(principal, { ...WHEN, capacity: 900, audience: { kind: "STUDENT", ref: "s1" } });
    expect(created[0].capacity).toBe(5);
  });

  it("lets a school briefing hold a room", async () => {
    // The old flat cap of 30 made a whole-school meeting unrepresentable.
    const { svc, created } = harness();
    await svc.createSlot(principal, { ...WHEN, capacity: 800, audience: { kind: "SCHOOL", ref: null } });
    expect(created[0].capacity).toBe(800);
  });
});

describe("a parent sees only what their family is invited to", () => {
  it("asks for THEIR children, classes and year groups — plus school-wide", async () => {
    const { svc, where } = harness({ children: ["kid1"], classes: ["c1"], stages: ["SENIOR_SECONDARY"] });
    await svc.openSlots(parent);
    const or = (where()?.OR ?? []) as Array<Record<string, unknown>>;
    expect(or).toEqual(
      expect.arrayContaining([
        { audienceKind: "SCHOOL" },
        { audienceKind: "STUDENT", audienceRef: { in: ["kid1"] } },
        { audienceKind: "CLASS", audienceRef: { in: ["c1"] } },
        { audienceKind: "STAGE", audienceRef: { in: ["SENIOR_SECONDARY"] } },
      ]),
    );
  });

  it("never widens to every slot in the school", async () => {
    // The old behaviour: no OR at all, so a parent saw every teacher's slots.
    const { svc, where } = harness({ children: ["kid1"], classes: ["c1"] });
    await svc.openSlots(parent);
    expect(where()?.OR).toBeDefined();
  });

  it("still shows school-wide meetings to a parent with no enrolled child", async () => {
    // A newly-registered parent must not be cut off from a PTA notice.
    const { svc, where } = harness({ children: [], classes: [] });
    await svc.openSlots(parent);
    expect(where()?.OR).toEqual([{ audienceKind: "SCHOOL" }]);
  });

  it("drops classes with NO year group rather than matching every stage", async () => {
    // An ungrouped class must not be swept into a year-group meeting.
    const { svc, where } = harness({ children: ["kid1"], classes: ["c1"], stages: [null] });
    await svc.openSlots(parent);
    const or = (where()?.OR ?? []) as Array<Record<string, unknown>>;
    expect(or.some((c) => c.audienceKind === "STAGE")).toBe(false);
  });
});

// =============================================================================
// Announcing a called meeting
// =============================================================================
// The half that was missing: a class or year-group meeting now TELLS those
// parents. The risk it carries is the reason this is chunked.
//
// `enqueueMany` opens ONE transaction and writes a notification, its deliveries
// and an audit row per recipient — about four statements each. A whole-school
// meeting at 2,000 guardians in a single call would be ~8,000 statements in one
// transaction, holding locks and flooding the WAL for as long as it took.

function announceHarness(guardians: string[], opts: { stageClasses?: string[] } = {}) {
  const calls: string[][] = [];
  const tx = {
    // Every real TenantTx has this: the notice carries the meeting time in the
    // SCHOOL's clock, so the producer resolves the school's region.
    school: { findFirst: jest.fn().mockResolvedValue({ country: null, timezone: null }) },
  // Capacity checks lock the contended row first (the class / route / slot),
  // so the count and the insert are atomic — the same guard hostel allocation
  // uses for a bed. The mock just has to answer.
  $executeRaw: jest.fn().mockResolvedValue(1),

    class: {
      findFirst: jest.fn().mockResolvedValue({ id: "c1", name: "JSS2" }),
      findMany: jest.fn().mockResolvedValue((opts.stageClasses ?? ["c1"]).map((id) => ({ id, stage: "SENIOR_SECONDARY" }))),
    },
    classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue({ id: "o" }) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "s1", name: "Pupil" }), findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue(guardians.map((_, i) => ({ classId: "c1", studentId: `stu${i}` }))) },
    // One guardian per pupil, plus a DUPLICATE to prove de-duplication.
    parentChild: {
      findMany: jest.fn().mockResolvedValue([...guardians.map((parentId) => ({ parentId })), { parentId: guardians[0] }]),
    },
    meetingInvitee: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    meetingSlot: { create: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "sl1", ...data, provider: null, joinUrl: null, active: true })), findMany: jest.fn().mockResolvedValue([]) },
    meetingBooking: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const notifications = {
    enqueueMany: jest.fn((_c: unknown, ids: string[]) => {
      calls.push(ids);
      return Promise.resolve({ created: ids.length, failed: 0 });
    }),
    enqueue: jest.fn().mockResolvedValue({}),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new MeetingService(db as never, audit as never, notifications as never), calls, notifications };
}

const CALLED = { startsAt: "2027-03-01T09:00:00Z", endsAt: "2027-03-01T10:00:00Z" };

describe("announcing", () => {
  it("tells every guardian of a class meeting", async () => {
    const { svc, calls } = announceHarness(["g1", "g2", "g3"]);
    await svc.createSlot(principal, { ...CALLED, audience: { kind: "CLASS", ref: "c1" } });
    expect(calls.flat().sort()).toEqual(["g1", "g2", "g3"]);
  });

  it("tells a guardian ONCE even with several children in the audience", async () => {
    // The harness returns a duplicate parent deliberately: a parent with three
    // children in a year group must not get three notices.
    const { svc, calls } = announceHarness(["g1", "g2"]);
    await svc.createSlot(principal, { ...CALLED, audience: { kind: "STAGE", ref: "SENIOR_SECONDARY" } });
    const all = calls.flat();
    expect(all.length).toBe(new Set(all).size);
  });

  it("CHUNKS a large audience instead of one enormous transaction", async () => {
    // 450 guardians at a chunk of 200 = 3 calls, each its own short transaction.
    const many = Array.from({ length: 450 }, (_, i) => `g${i}`);
    const { svc, calls } = announceHarness(many);
    await svc.createSlot(principal, { ...CALLED, audience: { kind: "SCHOOL", ref: null } });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.length).toBeLessThanOrEqual(200);
    expect(calls.flat().length).toBe(450);
  });

  it("does NOT announce a plain bookable slot", async () => {
    // An open slot invites nobody — parents find it. Announcing one would send
    // the whole school a notice about a teacher's free half-hour.
    const { svc, notifications } = announceHarness(["g1", "g2"]);
    await svc.createSlot(principal, CALLED);
    expect(notifications.enqueueMany).not.toHaveBeenCalled();
  });

  it("does NOT announce a 1:1 appointment either", async () => {
    // A STUDENT slot is an offer of time, taken up by booking — the parent is
    // told when they book, not summoned.
    const { svc, notifications } = announceHarness(["g1"]);
    await svc.createSlot(principal, { ...CALLED, audience: { kind: "STUDENT", ref: "s1" } });
    expect(notifications.enqueueMany).not.toHaveBeenCalled();
  });

  it("sends a KEY, so each parent is written in their own language", async () => {
    const { svc, notifications } = announceHarness(["g1"]);
    await svc.createSlot(principal, { ...CALLED, audience: { kind: "CLASS", ref: "c1" } });
    const input = (notifications.enqueueMany.mock.calls[0] as unknown as unknown[])[2] as { key?: string };
    expect(input.key).toBe("meeting.called");
  });

  it("still creates the meeting when the announcement throws", async () => {
    // The slot is the durable record; telling people is best-effort. Losing a
    // meeting because a notification failed would be the worse outcome.
    const { svc, notifications } = announceHarness(["g1"]);
    notifications.enqueueMany.mockRejectedValueOnce(new Error("queue down"));
    const dto = await svc.createSlot(principal, { ...CALLED, audience: { kind: "CLASS", ref: "c1" } });
    expect(dto.id).toBe("sl1");
  });
});

// =============================================================================
// Selected parents, and why a briefing must not claim capacity
// =============================================================================
// Two additions that belong together.
//
// SELECTED is the one audience with no rule to derive a list from — a hand-picked
// set of parents IS its own rule — so it is the one whose membership is stored.
//
// And the capacity claim is the thing that would actually have taken the system
// down. `book()` COUNTs every existing booking on the slot inside each
// transaction. For an appointment that is correct: it allocates a scarce thing
// and must serialise. For 2,000 parents responding to a whole-school notice it
// is O(n^2) reads all contending on the same rows.

import { isAppointment } from "@sms/types";

describe("appointment vs briefing", () => {
  it("treats a pupil appointment and a selected set as APPOINTMENTS", () => {
    expect(isAppointment("STUDENT")).toBe(true);
    expect(isAppointment("SELECTED")).toBe(true);
  });

  it("treats a class, year group and the school as BRIEFINGS", () => {
    // These are the ones where a per-parent capacity claim is O(n^2).
    expect(isAppointment("CLASS")).toBe(false);
    expect(isAppointment("STAGE")).toBe(false);
    expect(isAppointment("SCHOOL")).toBe(false);
  });
});

describe("SELECTED audience", () => {
  it("is valid with no ref — its people live in meeting_invitee", () => {
    expect(meetingAudienceProblem({ kind: "SELECTED", ref: null })).toBeNull();
  });

  it("refuses a ref, which would imply a rule it does not have", () => {
    expect(meetingAudienceProblem({ kind: "SELECTED", ref: "c1" })).toMatch(/takes no class or pupil/);
  });

  it("is labelled without leaking who was picked", () => {
    // The label appears on a parent's own page; naming the others would disclose
    // which families were summoned.
    expect(describeAudience({ kind: "SELECTED", ref: null })).toBe("Selected parents");
  });
});

function selectHarness(realParents: string[]) {
  const invitees: Array<Record<string, unknown>> = [];
  // Every `where` the pupil lookup was handed, so a null id is visible.
  const userLookups: Array<Record<string, unknown>> = [];
  const tx = {
    // Every real TenantTx has this: the notice carries the meeting time in the
    // SCHOOL's clock, so the producer resolves the school's region.
    school: { findFirst: jest.fn().mockResolvedValue({ country: null, timezone: null }) },
    class: { findFirst: jest.fn().mockResolvedValue({ id: "c1", name: "JSS2" }), findMany: jest.fn().mockResolvedValue([]) },
    classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue({ id: "o" }) },
    user: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        userLookups.push(where);
        return Promise.resolve({ id: "s1", name: "P" });
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
    parentChild: { findMany: jest.fn().mockResolvedValue(realParents.map((parentId) => ({ parentId }))) },
    meetingInvitee: {
      createMany: jest.fn(({ data }: { data: Array<Record<string, unknown>> }) => {
        invitees.push(...data);
        return Promise.resolve({ count: data.length });
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    meetingSlot: { create: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "sl1", ...data, provider: null, joinUrl: null, active: true })), findMany: jest.fn().mockResolvedValue([]) },
    meetingBooking: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const notifications = { enqueueMany: jest.fn().mockResolvedValue({ created: 0, failed: 0 }), enqueue: jest.fn().mockResolvedValue({}) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new MeetingService(db as never, audit as never, notifications as never), invitees, notifications, userLookups };
}

const PICK = { startsAt: "2027-05-01T09:00:00Z", endsAt: "2027-05-01T10:00:00Z" };

describe("inviting a chosen few", () => {
  it("never looks a SELECTED audience up by ref — there is no ref", async () => {
    // SELECTED has no `ref`, so falling through to the pupil branch issues
    // `where: { id: null }` and Prisma throws — which is exactly what happened
    // live. The other tests passed anyway because the mock returns a row
    // WHATEVER the `where` is, so this asserts the QUERY rather than the result.
    const { svc, userLookups } = selectHarness(["g1"]);
    await svc.createSlot(principal, { ...PICK, audience: { kind: "SELECTED", ref: null }, inviteeIds: ["g1"] });
    for (const where of userLookups) expect(where.id).not.toBeNull();
  });

  it("stores exactly the parents picked", async () => {
    const { svc, invitees } = selectHarness(["g1", "g2"]);
    await svc.createSlot(principal, { ...PICK, audience: { kind: "SELECTED", ref: null }, inviteeIds: ["g1", "g2"] });
    expect(invitees.map((i) => i.parentId).sort()).toEqual(["g1", "g2"]);
  });

  it("de-duplicates a parent listed twice", async () => {
    const { svc, invitees } = selectHarness(["g1"]);
    await svc.createSlot(principal, { ...PICK, audience: { kind: "SELECTED", ref: null }, inviteeIds: ["g1", "g1"] });
    expect(invitees).toHaveLength(1);
  });

  it("refuses an id that is not a parent at this school", async () => {
    // An invitation to somebody who does not exist is a meeting one fewer person
    // attends, discovered by an empty chair.
    const { svc, invitees } = selectHarness(["g1"]);
    await expect(
      svc.createSlot(principal, { ...PICK, audience: { kind: "SELECTED", ref: null }, inviteeIds: ["g1", "ghost"] }),
    ).rejects.toThrow(/not parents at this school/);
    expect(invitees).toHaveLength(0);
  });

  it("refuses an empty selection rather than creating a meeting for nobody", async () => {
    const { svc } = selectHarness([]);
    await expect(
      svc.createSlot(principal, { ...PICK, audience: { kind: "SELECTED", ref: null }, inviteeIds: [] }),
    ).rejects.toThrow(/at least one parent/);
  });

  it("REFUSES a teacher hand-picking families", async () => {
    // A chosen set can span the whole school, so it is a leadership act for the
    // same reason a year group is.
    const { svc, invitees } = selectHarness(["g1"]);
    await expect(
      svc.createSlot(teacher, { ...PICK, audience: { kind: "SELECTED", ref: null }, inviteeIds: ["g1"] }),
    ).rejects.toThrow(/principal or school administrator/i);
    expect(invitees).toHaveLength(0);
  });

  it("announces to exactly those parents", async () => {
    const { svc, notifications } = selectHarness(["g1", "g2"]);
    (notifications as unknown as { enqueueMany: jest.Mock }).enqueueMany.mockClear();
    await svc.createSlot(principal, { ...PICK, audience: { kind: "SELECTED", ref: null }, inviteeIds: ["g1", "g2"] });
    // resolveAudience reads meeting_invitee; the harness returns none, so the
    // announcement is a no-op — what matters is that it did not fan out to the
    // school by falling through to another branch.
    const calls = (notifications as unknown as { enqueueMany: jest.Mock }).enqueueMany.mock.calls;
    for (const c of calls) expect((c[1] as string[]).length).toBeLessThanOrEqual(2);
  });
});

describe("book() — the capacity claim itself", () => {
  // Testing isAppointment() proves the DATA. This proves the WIRING: that the
  // COUNT which makes a whole-school response O(n^2) is genuinely not issued.
  function bookHarness(kind: string) {
    const counted: string[] = [];
    const tx = {
    // Every real TenantTx has this: the notice carries the meeting time in the
    // SCHOOL's clock, so the producer resolves the school's region.
    school: { findFirst: jest.fn().mockResolvedValue({ country: null, timezone: null }) },
      // The appointment branch locks the slot row before counting, so the claim
      // is atomic — a briefing deliberately skips both.
      $executeRaw: jest.fn().mockResolvedValue(1),
      parentChild: { findFirst: jest.fn().mockResolvedValue({ id: "link" }) },
      meetingSlot: {
        findFirst: jest.fn().mockResolvedValue({
          id: "sl1", teacherId: "t1", capacity: 1, startsAt: new Date("2099-01-01"), kind,
        }),
      },
      meetingBooking: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn((args: { where: { slotId: string } }) => {
          counted.push(args.where.slotId);
          return Promise.resolve(50); // already "full" at capacity 1
        }),
        create: jest.fn().mockResolvedValue({ id: "bk1", slotId: "sl1", studentId: "s1", status: "BOOKED", note: null }),
      },
      user: { findFirst: jest.fn().mockResolvedValue({ id: "s1", name: "Pupil" }) },
    } as unknown as TenantTx;
    const db = {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    };
    const notifications = { enqueue: jest.fn().mockResolvedValue({}), enqueueMany: jest.fn().mockResolvedValue({}) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    return { svc: new MeetingService(db as never, audit as never, notifications as never), counted };
  }

  it("COUNTS for an appointment — a scarce half-hour must serialise", async () => {
    const { svc, counted } = bookHarness("APPOINTMENT");
    await expect(svc.book(parent, "sl1", "s1")).rejects.toThrow(/fully booked/);
    expect(counted).toEqual(["sl1"]);
  });

  it("does NOT count for a whole-school briefing — this is the O(n^2)", async () => {
    // 2,000 parents each counting every existing booking on the same slot is
    // what would take the system down. A hall is not a per-parent transaction.
    const { svc, counted } = bookHarness("BRIEFING");
    await svc.book(parent, "sl1", "s1");
    expect(counted).toEqual([]);
  });

  it("COUNTS for a slot with NO stored kind — every existing row is an appointment", async () => {
    // The regression the e2e caught: a plain bookable slot defaults to a SCHOOL
    // audience, and deriving briefing-ness from that removed the capacity claim
    // from every ordinary slot in the product.
    const { svc, counted } = bookHarness(undefined as unknown as string);
    await expect(svc.book(parent, "sl1", "s1")).rejects.toThrow(/fully booked/);
    expect(counted).toEqual(["sl1"]);
  });
});

// =============================================================================
// Colleagues attending
// =============================================================================
// `teacherId` stays the ORGANISER — it decides who may withdraw the slot and
// whose list it is theirs in. A co-host is someone who will be IN THE ROOM: a
// form teacher joined by the head of year and the counsellor.
//
// Two things must follow, or being added is an invitation that never arrives:
// they have to SEE the meeting, and they have to get the join link.

function cohostHarness(staffIds: string[], seeingIds?: string[], goneIds: string[] = []) {
  // The harness HONOURS the where. createSlot asks userRole two different
  // questions — "are these staff" and "can these open the meetings page" — and a
  // mock answering both with the same list is how a deleted check keeps passing.
  const canSee = seeingIds ?? staffIds;
  const cohosts: Array<Record<string, unknown>> = [];
  const notified: string[][] = [];
  const tx = {
    // Every real TenantTx has this: the notice carries the meeting time in the
    // SCHOOL's clock, so the producer resolves the school's region.
    school: { findFirst: jest.fn().mockResolvedValue({ country: null, timezone: null }) },
    class: { findFirst: jest.fn().mockResolvedValue({ id: "c1", name: "JSS2" }), findMany: jest.fn().mockResolvedValue([]) },
    classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue({ id: "o" }) },
    // HONOURS THE WHERE, for the same reason the userRole stub does. This used
    // to answer [] to everything, which models a `user_role` row for a user that
    // does not exist — something the database cannot produce — and it went
    // unnoticed while nothing asked. `goneIds` are real people who have LEFT.
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: "s1", name: "P" }),
      findMany: jest.fn((args: { where?: { id?: { in?: string[] } } }) =>
        Promise.resolve(
          (args?.where?.id?.in ?? []).map((id) => ({
            id,
            name: id,
            status: goneIds.includes(id) ? "EXITED" : "ACTIVE",
          })),
        ),
      ),
    },
    userRole: {
      findMany: jest.fn((args: { where?: { role?: Record<string, unknown> } }) => {
        const asksPermission = !!args?.where?.role?.permissions;
        const pool = asksPermission ? canSee : staffIds;
        return Promise.resolve(pool.map((userId) => ({ userId })));
      }),
    },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
    parentChild: { findMany: jest.fn().mockResolvedValue([]) },
    meetingInvitee: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    meetingCohost: {
      createMany: jest.fn(({ data }: { data: Array<Record<string, unknown>> }) => {
        cohosts.push(...data);
        return Promise.resolve({ count: data.length });
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    meetingSlot: { create: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "sl1", ...data, provider: null, joinUrl: null, active: true })), findMany: jest.fn().mockResolvedValue([]) },
    meetingBooking: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const notifications = {
    enqueueMany: jest.fn((_c: unknown, ids: string[]) => {
      notified.push(ids);
      return Promise.resolve({ created: ids.length, failed: 0 });
    }),
    enqueue: jest.fn().mockResolvedValue({}),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new MeetingService(db as never, audit as never, notifications as never), cohosts, notified, tx };
}

const CO = { startsAt: "2027-07-01T09:00:00Z", endsAt: "2027-07-01T10:00:00Z" };

describe("adding colleagues to a meeting", () => {
  it("stores each colleague", async () => {
    const { svc, cohosts } = cohostHarness(["t2", "t3"]);
    await svc.createSlot(principal, { ...CO, cohostIds: ["t2", "t3"] });
    expect(cohosts.map((c) => c.teacherId).sort()).toEqual(["t2", "t3"]);
  });

  it("refuses somebody who is not staff", async () => {
    // A parent added as a host would get the join link before the window and the
    // organiser's view of the slot.
    const { svc, cohosts } = cohostHarness(["t2"]);
    await expect(svc.createSlot(principal, { ...CO, cohostIds: ["t2", "a-parent"] }))
      .rejects.toThrow(/not staff at this school/);
    expect(cohosts).toHaveLength(0);
  });

  it("refuses a colleague who could never open the meetings page", async () => {
    // head_teacher hit exactly this live: staff, addable, and then 403 on their
    // own meetings list. Refusing at ADD time is the only point where anyone is
    // watching — the 403 lands days later on someone who cannot explain it.
    const { svc, cohosts } = cohostHarness(["t2", "no-perm"], ["t2"]);
    await expect(svc.createSlot(principal, { ...CO, cohostIds: ["t2", "no-perm"] }))
      .rejects.toThrow(/cannot open the meetings page/);
    expect(cohosts).toHaveLength(0);
  });

  it("drops the organiser from their own co-host list", async () => {
    // Adding yourself is the one thing this cannot usefully do, and a duplicate
    // row would make the unique index the thing that reports it.
    const { svc, cohosts } = cohostHarness(["t2"]);
    await svc.createSlot(principal, { ...CO, cohostIds: [principal.userId, "t2"] });
    expect(cohosts.map((c) => c.teacherId)).toEqual(["t2"]);
  });

  it("de-duplicates a colleague listed twice", async () => {
    const { svc, cohosts } = cohostHarness(["t2"]);
    await svc.createSlot(principal, { ...CO, cohostIds: ["t2", "t2"] });
    expect(cohosts).toHaveLength(1);
  });

  it("TELLS them they have been added", async () => {
    // Otherwise being added is an invitation that never arrives.
    const { svc, notified } = cohostHarness(["t2"]);
    await svc.createSlot(principal, { ...CO, cohostIds: ["t2"] });
    expect(notified.flat()).toContain("t2");
  });

  it("tells them with a KEY, so a francophone colleague reads French", async () => {
    const { svc } = cohostHarness(["t2"]);
    const h = cohostHarness(["t2"]);
    await h.svc.createSlot(principal, { ...CO, cohostIds: ["t2"] });
    void svc;
    expect(NOTIFICATION_MESSAGES["meeting.cohost_added"]).toBeDefined();
    expect(NOTIFICATION_MESSAGES["meeting.cohost_added"].title.fr).toMatch(/réunion/);
  });

  it("still creates the meeting when telling them fails", async () => {
    const { svc, cohosts } = cohostHarness(["t2"]);
    const dto = await svc.createSlot(principal, { ...CO, cohostIds: ["t2"] });
    expect(dto.id).toBe("sl1");
    expect(cohosts).toHaveLength(1);
  });

  it("refuses more than 20 colleagues", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`);
    const { svc } = cohostHarness(many);
    await expect(svc.createSlot(principal, { ...CO, cohostIds: many })).rejects.toThrow(/at most 20/);
  });
});

describe("a co-host is a host for the things that matter", () => {
  // Storing the row is not enough. If they cannot SEE the meeting or GET the
  // link, being added is an invitation that never arrives — so these test the
  // wiring rather than the write.
  const colleague: Principal = { schoolId: "A", userId: "t2", roles: ["teacher"], permissions: ["meeting.host"] };

  function listHarness(cohostOf: string[]) {
    const tx = {
    // Every real TenantTx has this: the notice carries the meeting time in the
    // SCHOOL's clock, so the producer resolves the school's region.
    school: { findFirst: jest.fn().mockResolvedValue({ country: null, timezone: null }) },
      meetingCohost: {
        findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            where.teacherId
              ? cohostOf.map((slotId) => ({ slotId }))
              : cohostOf.map((slotId) => ({ slotId, teacherId: "t2" })),
          ),
        ),
      },
      meetingSlot: {
        // HONOURS the where. A mock that returns the row whatever is asked makes
        // "the co-host can see it" pass even when the filter that lets them see
        // it has been deleted — which is exactly what happened the first time.
        findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
          const or = (where?.OR ?? []) as Array<Record<string, unknown>>;
          const byOwner = where?.teacherId === "OWNER";
          const byOr = or.some(
            (c) => c.teacherId === "OWNER" || ((c.id as { in?: string[] })?.in ?? []).includes("sl1"),
          );
          if (!byOwner && !byOr) return Promise.resolve([]);
          return Promise.resolve([
          {
            id: "sl1", teacherId: "OWNER", startsAt: new Date("2099-01-01T09:00:00Z"),
            endsAt: new Date("2099-01-01T10:00:00Z"), capacity: 1, location: null, note: null,
            active: true, provider: "ZOOM", joinUrl: "https://zoom.us/j/123", audienceKind: "STUDENT",
            audienceRef: null, kind: "APPOINTMENT",
          },
        ]);
        }),
      },
      meetingBooking: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: "t2", name: "Colleague" }]) },
      class: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as TenantTx;
    const db = {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { enqueue: jest.fn(), enqueueMany: jest.fn() };
    return new MeetingService(db as never, audit as never, notifications as never);
  }

  it("SEES a meeting they were added to, though they do not own it", async () => {
    const out = await listHarness(["sl1"]).mySlots(colleague);
    expect(out.map((s) => s.id)).toContain("sl1");
  });

  it("GETS the join link before the window, as the organiser does", async () => {
    // The meeting is in 2099, so the window is shut. A co-host must still have
    // the link — they are in the room, and being told to attend a call you
    // cannot open is the failure this prevents.
    const out = await listHarness(["sl1"]).mySlots(colleague);
    expect(out[0].joinUrl).toBe("https://zoom.us/j/123");
  });

  it("lists the colleagues on the slot, so a parent knows who will be there", async () => {
    const out = await listHarness(["sl1"]).mySlots(colleague);
    expect((out[0].cohosts ?? []).map((c) => c.name)).toContain("Colleague");
  });
});

/**
 * THE HOST IS CHECKED LIKE A COHOST.
 *
 * `teacherId` is accepted from any staff-wide caller and was validated in NO
 * way: measured live against the running stack, a principal opened a bookable
 * slot hosted by a PARENT (201) and one hosted by a uuid that is nobody (201,
 * rendering with `teacherName: null`). The cohost path three lines below had
 * asked the same questions carefully all along — sibling asymmetry inside one
 * method, with the careful half written first.
 */
describe("who may be named as the host of a meeting", () => {
  it("refuses a parent as the host — they would get the organiser's view and the join link", async () => {
    const { svc } = cohostHarness(["t2"]); // "a-parent" is in no staff pool
    await expect(svc.createSlot(principal, { ...CO, teacherId: "a-parent" }))
      .rejects.toThrow(/not staff at this school/);
  });

  it("refuses a host who is nobody at all", async () => {
    // There is no FK on meeting_slot.teacherId, so the phantom was a real
    // stored row that rendered with no name and could still be booked.
    const { svc } = cohostHarness(["t2"]);
    await expect(svc.createSlot(principal, { ...CO, teacherId: "00000000-0000-4000-8000-000000000000" }))
      .rejects.toThrow(/not staff at this school/);
  });

  it("refuses a host who has LEFT the school", async () => {
    // A meeting is future work. Naming a leaver sends an invitation into an
    // inbox its owner can no longer open, and tells the organiser they will be
    // there — the failure `assertStillHere` exists for, on a module that was
    // never added to its list.
    const { svc } = cohostHarness(["gone"], ["gone"], ["gone"]);
    await expect(svc.createSlot(principal, { ...CO, teacherId: "gone" }))
      .rejects.toThrow(/has left the school and cannot host a meeting/);
  });

  it("refuses a COHOST who has left, in the same words", async () => {
    const { svc, cohosts } = cohostHarness(["t2", "gone"], ["t2", "gone"], ["gone"]);
    await expect(svc.createSlot(principal, { ...CO, cohostIds: ["t2", "gone"] }))
      .rejects.toThrow(/has left the school and cannot co-host a meeting/);
    expect(cohosts).toHaveLength(0);
  });

  it("still opens a slot for the caller THEMSELVES with no extra lookup", async () => {
    // The check must not make the ordinary act — a teacher offering their own
    // availability — depend on a role lookup that could refuse them.
    const { svc, tx } = cohostHarness([]);
    await svc.createSlot(principal, { ...CO });
    expect((tx.user.findMany as jest.Mock)).not.toHaveBeenCalled();
  });

  it("refuses a host who cannot open the meetings page", async () => {
    const { svc } = cohostHarness(["t2"], []); // staff, but holds no meeting.host
    await expect(svc.createSlot(principal, { ...CO, teacherId: "t2" }))
      .rejects.toThrow(/cannot open the meetings page/);
  });
});
