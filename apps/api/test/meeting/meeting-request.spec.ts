// =============================================================================
// Parent-initiated meeting requests — routing and scoping
// =============================================================================
// The design decision under test: the TEACHER is the approver, because they own
// the time. Leadership gets visibility and the exception path. The two places
// that must not be got wrong are WHO a request reaches and WHO may answer it.
//
// The tx fake honours the `where` wherever the behaviour under test IS a
// filter — a mock that returns a row regardless is how a deleted scope check
// stays green.
// =============================================================================

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { initialRequestStatus, isOpenRequest, needsLeadership } from "@sms/types";
import { MeetingRequestService } from "../../src/meeting/meeting-request.service";
import type { Principal, TenantTx } from "../../src/integrity/integrity.foundation";

const parent = { userId: "par1", schoolId: "s1", roles: ["parent"], permissions: [] } as unknown as Principal;
const teacher = { userId: "tea1", schoolId: "s1", roles: ["teacher"], permissions: [] } as unknown as Principal;
const principal = { userId: "pri1", schoolId: "s1", roles: ["principal"], permissions: [] } as unknown as Principal;

describe("where a new request starts", () => {
  it("goes straight to the teacher by default", () => {
    // The whole point: one decision, by the person whose diary it is.
    expect(initialRequestStatus("PROGRESS", false)).toBe("PENDING_TEACHER");
  });

  it("goes to leadership when the school opted in", () => {
    expect(initialRequestStatus("PROGRESS", true)).toBe("PENDING_APPROVAL");
  });

  it("a CONCERN goes to leadership even when the school did NOT opt in", () => {
    // A concern addressed to the person it may be about is the one routing this
    // feature must not get wrong.
    expect(initialRequestStatus("CONCERN", false)).toBe("PENDING_APPROVAL");
    expect(needsLeadership("CONCERN", false)).toBe(true);
  });

  it("only the two waiting states count as open", () => {
    expect(["PENDING_APPROVAL", "PENDING_TEACHER"].every(isOpenRequest)).toBe(true);
    expect(["ACCEPTED", "DECLINED", "CANCELLED"].some(isOpenRequest)).toBe(false);
  });
});

function harness(opts: {
  isMine?: boolean;
  enrolled?: string[];
  teaches?: boolean;
  supervises?: boolean;
  existingOpen?: boolean;
  requireApproval?: boolean;
  row?: Record<string, unknown> | null;
} = {}) {
  const created: Array<Record<string, unknown>> = [];
  const slots: Array<Record<string, unknown>> = [];
  const bookings: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let listedWhere: Record<string, unknown> | null = null;

  const tx = {
    parentChild: {
      // Honours the where: "is this MY child" is the check under test.
      findFirst: jest.fn((a: { where: { parentId?: string } }) =>
        Promise.resolve(opts.isMine === false ? null : a.where.parentId === parent.userId ? { id: "pc1" } : null),
      ),
    },
    enrollment: {
      findMany: jest.fn().mockResolvedValue((opts.enrolled ?? ["c1"]).map((classId) => ({ classId }))),
    },
    classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue(opts.teaches === false ? null : { id: "o1" }) },
    class: { findFirst: jest.fn().mockResolvedValue(opts.supervises ? { id: "c1" } : null) },
    school: { findFirst: jest.fn().mockResolvedValue({ requireMeetingApproval: opts.requireApproval ?? false }) },
    meetingRequest: {
      findFirst: jest.fn((a: { where: Record<string, unknown> }) =>
        Promise.resolve(a.where.status ? (opts.existingOpen ? { id: "old" } : null) : (opts.row ?? null)),
      ),
      findMany: jest.fn((a: { where: Record<string, unknown> }) => {
        listedWhere = a.where;
        return Promise.resolve([]);
      }),
      create: jest.fn((a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return Promise.resolve({ ...a.data, id: "req1", createdAt: new Date(), updatedAt: new Date() });
      }),
      updateMany: jest.fn((a: { data: Record<string, unknown> }) => {
        updates.push(a.data);
        return Promise.resolve({ count: 1 });
      }),
    },
    meetingSlot: {
      create: jest.fn((a: { data: Record<string, unknown> }) => {
        slots.push(a.data);
        return Promise.resolve({ id: "slot1" });
      }),
    },
    meetingBooking: {
      create: jest.fn((a: { data: Record<string, unknown> }) => {
        bookings.push(a.data);
        return Promise.resolve({ id: "bk1" });
      }),
    },
    userRole: { findMany: jest.fn().mockResolvedValue([{ userId: "pri1" }]) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "par1", name: "Parent" }, { id: "tea1", name: "Teacher" }]) },
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const svc = new MeetingRequestService(
    db as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    { enqueueMany: jest.fn().mockResolvedValue({}) } as never,
  );
  return { svc, tx, created, slots, bookings, updates, get listedWhere() { return listedWhere; } };
}

const ask = { studentId: "stu1", teacherId: "tea1", topic: "PROGRESS", note: "How is he doing?" };

describe("a parent asking", () => {
  it("creates a request routed to the teacher", async () => {
    const h = harness({});
    await h.svc.create(parent, ask);
    expect(h.created[0]).toMatchObject({ status: "PENDING_TEACHER", teacherId: "tea1", parentId: "par1" });
  });

  it("404s a pupil who is not theirs", async () => {
    // Never confirm a pupil exists to somebody unrelated.
    const h = harness({ isMine: false });
    await expect(h.svc.create(parent, ask)).rejects.toThrow(NotFoundException);
    expect(h.created).toHaveLength(0);
  });

  it("404s a teacher who does not teach their child", async () => {
    // Otherwise a parent could address any member of staff in the school.
    const h = harness({ teaches: false, supervises: false });
    await expect(h.svc.create(parent, ask)).rejects.toThrow(/does not teach your child/);
  });

  it("accepts the class SUPERVISOR even when they teach no subject", async () => {
    const h = harness({ teaches: false, supervises: true });
    await expect(h.svc.create(parent, ask)).resolves.toBeDefined();
  });

  it("refuses a second open request to the same teacher", async () => {
    // A parent waiting on a slow reply re-asks; the teacher's inbox fills with
    // the same conversation.
    const h = harness({ existingOpen: true });
    await expect(h.svc.create(parent, ask)).rejects.toThrow(ConflictException);
  });

  it("routes a CONCERN to leadership regardless of the school setting", async () => {
    const h = harness({ requireApproval: false });
    await h.svc.create(parent, { ...ask, topic: "CONCERN" });
    expect(h.created[0]).toMatchObject({ status: "PENDING_APPROVAL" });
  });

  it("rejects an unknown topic", async () => {
    const h = harness({});
    await expect(h.svc.create(parent, { ...ask, topic: "WHATEVER" })).rejects.toThrow(BadRequestException);
  });
});

describe("who sees which requests", () => {
  it("a parent and a teacher see only rows they are on", async () => {
    const h = harness({});
    await h.svc.list(parent);
    expect(h.listedWhere).toEqual({ OR: [{ parentId: "par1" }, { teacherId: "par1" }] });
  });

  it("leadership sees every request", async () => {
    // Visibility is what replaces a gate — it has to be complete.
    const h = harness({});
    await h.svc.list(principal);
    expect(h.listedWhere).toEqual({});
  });

  it("the open filter narrows to the waiting states", async () => {
    const h = harness({});
    await h.svc.list(principal, { open: true });
    expect(h.listedWhere).toMatchObject({ status: { in: ["PENDING_APPROVAL", "PENDING_TEACHER"] } });
  });
});

describe("the teacher answering", () => {
  const pending = {
    id: "req1",
    parentId: "par1",
    studentId: "stu1",
    teacherId: "tea1",
    topic: "PROGRESS",
    note: null,
    status: "PENDING_TEACHER",
    decidedById: null,
    decisionNote: null,
    slotId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("ACCEPT opens a real slot and books the parent into it", async () => {
    // Not a second kind of meeting: the join window, the reminder and the
    // record all come from the slot model that already runs every other one.
    const h = harness({ row: pending });
    await h.svc.decide(teacher, "req1", {
      action: "ACCEPT",
      startsAt: "2027-05-01T09:00:00.000Z",
      endsAt: "2027-05-01T09:30:00.000Z",
    });
    expect(h.slots[0]).toMatchObject({ audienceKind: "STUDENT", audienceRef: "stu1", capacity: 1, kind: "APPOINTMENT" });
    expect(h.bookings[0]).toMatchObject({ parentId: "par1", studentId: "stu1", status: "BOOKED" });
    expect(h.updates[0]).toMatchObject({ status: "ACCEPTED", slotId: "slot1" });
  });

  it("DECLINE demands a reason", async () => {
    // A decline with no reason is the commonest cause of the same request
    // arriving again next week.
    const h = harness({ row: pending });
    await expect(h.svc.decide(teacher, "req1", { action: "DECLINE" })).rejects.toThrow(/Say why/);
    expect(h.updates).toHaveLength(0);
  });

  it("ACCEPT without a time is refused before anything is written", async () => {
    const h = harness({ row: pending });
    await expect(h.svc.decide(teacher, "req1", { action: "ACCEPT" })).rejects.toThrow(/Choose a time/);
    expect(h.slots).toHaveLength(0);
  });

  it("refuses a meeting that ends before it starts", async () => {
    const h = harness({ row: pending });
    await expect(
      h.svc.decide(teacher, "req1", { action: "ACCEPT", startsAt: "2027-05-01T10:00:00.000Z", endsAt: "2027-05-01T09:00:00.000Z" }),
    ).rejects.toThrow(/end after it starts/);
  });

  it("404s a teacher the request was not addressed to", async () => {
    const h = harness({ row: { ...pending, teacherId: "someone-else" } });
    await expect(
      h.svc.decide(teacher, "req1", { action: "ACCEPT", startsAt: "2027-05-01T09:00:00.000Z", endsAt: "2027-05-01T09:30:00.000Z" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("lets LEADERSHIP answer on a teacher's behalf", async () => {
    // The escalation path: a teacher who has left or is on leave must not
    // strand the parent for ever.
    const h = harness({ row: { ...pending, teacherId: "someone-else" } });
    await expect(
      h.svc.decide(principal, "req1", { action: "ACCEPT", startsAt: "2027-05-01T09:00:00.000Z", endsAt: "2027-05-01T09:30:00.000Z" }),
    ).resolves.toBeDefined();
  });
});

describe("leadership review", () => {
  const awaiting = {
    id: "req1", parentId: "par1", studentId: "stu1", teacherId: "tea1", topic: "CONCERN", note: null,
    status: "PENDING_APPROVAL", decidedById: null, decisionNote: null, slotId: null,
    createdAt: new Date(), updatedAt: new Date(),
  };

  it("PASS hands it to the teacher", async () => {
    const h = harness({ row: awaiting });
    await h.svc.review(principal, "req1", "PASS");
    expect(h.updates[0]).toMatchObject({ status: "PENDING_TEACHER", decidedById: "pri1" });
  });

  it("a teacher cannot act on the leadership stage", async () => {
    const h = harness({ row: awaiting });
    await expect(h.svc.review(teacher, "req1", "PASS")).rejects.toThrow(NotFoundException);
  });
});
