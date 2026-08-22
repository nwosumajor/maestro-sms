// =============================================================================
// Told when a duty is given, told nothing when it is taken away
// =============================================================================
// Assigning work notifies the person. Withdrawing it did not — anywhere:
//
//   assignInvigilator   "You're invigilating Maths Paper 1 … (Hall A)"
//   removeInvigilator   silent
//   deleteSitting       cascades EVERY seat and invigilator, silent
//   assignCover         "Cover lesson assigned"
//   removeCover         silent
//   deleteEntry         lesson_cover is ON DELETE CASCADE — silent
//
// So the only record a teacher had still told them to be in Hall A for an exam
// that no longer exists, or to teach a lesson that is no longer theirs. A
// teacher who turns up has wasted a free period; a teacher who does NOT turn up
// because they assumed it had been withdrawn is a class left unattended, which
// is the thing cover exists to prevent.
//
// The delete itself is legitimate — timetables change, exams are cancelled — so
// these notify rather than refuse. The defect was the silence.
//
// ONE NOTICE, SHARED. The cascade path and the explicit removal call the same
// method, so a reliever is told the same thing whichever way the duty vanished.
// =============================================================================

import { LessonCoverService } from "../../src/timetable/lesson-cover.service";
import { TimetableService } from "../../src/timetable/timetable.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = { schoolId: "A", userId: "admin", roles: ["school_admin"], permissions: ["timetable.write"] };

function makeCover(row: Record<string, unknown> | null) {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const tx = {
    lessonCover: {
      findFirst: jest.fn().mockResolvedValue(row),
      deleteMany: jest.fn().mockResolvedValue({ count: row ? 1 : 0 }),
    },
    timetableEntry: { findFirst: jest.fn().mockResolvedValue({ subject: "Maths", classId: "c1" }) },
    class: { findFirst: jest.fn().mockResolvedValue({ name: "JSS1 A" }) },
  } as unknown as TenantTx;
  const svc = Object.create(LessonCoverService.prototype) as LessonCoverService;
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) },
    audit: { record: jest.fn() },
    notifications: { enqueue },
    logger: { warn: jest.fn(), log: jest.fn() },
  });
  return { svc, enqueue };
}

describe("taking a cover lesson off somebody", () => {
  it("tells the reliever", async () => {
    const { svc, enqueue } = makeCover({
      coveringTeacherId: "t1",
      date: new Date("2026-12-01"),
      timetableEntryId: "e1",
    });
    await svc.removeCover(staff, "cov1");
    expect(enqueue).toHaveBeenCalledTimes(1);
    const msg = enqueue.mock.calls[0][1] as { recipientId: string; body: string };
    expect(msg.recipientId).toBe("t1");
    expect(msg.body).toMatch(/no longer covering Maths for JSS1 A on 2026-12-01/);
  });

  it("reads the row BEFORE deleting it", async () => {
    // After the delete there is nobody left to tell — the reliever's id is on
    // the row that has just gone.
    const { svc, enqueue } = makeCover({ coveringTeacherId: "t1", date: new Date("2026-12-01"), timetableEntryId: "e1" });
    await svc.removeCover(staff, "cov1");
    expect(enqueue).toHaveBeenCalled();
  });

  it("still removes the cover when the notice cannot be sent", async () => {
    // The duty is withdrawn whether or not the message gets through; failing
    // the removal would leave the roster wrong rather than merely quiet.
    const { svc } = makeCover({ coveringTeacherId: "t1", date: new Date("2026-12-01"), timetableEntryId: "e1" });
    (svc as unknown as { notifications: { enqueue: jest.Mock } }).notifications.enqueue = jest
      .fn()
      .mockRejectedValue(new Error("mail down"));
    await expect(svc.removeCover(staff, "cov1")).resolves.toEqual({ removed: true });
  });
});

describe("deleting the lesson the cover was attached to", () => {
  function makeTimetable(covers: Array<{ coveringTeacherId: string; date: Date }>) {
    const announce = jest.fn().mockResolvedValue(undefined);
    const tx = {
      timetableEntry: {
        findFirst: jest.fn().mockResolvedValue({ id: "e1", subject: "Maths", classId: "c1" }),
        delete: jest.fn().mockResolvedValue({}),
      },
      lessonCover: { findMany: jest.fn().mockResolvedValue(covers) },
      class: { findFirst: jest.fn().mockResolvedValue({ name: "JSS1 A" }) },
    } as unknown as TenantTx;
    const svc = Object.create(TimetableService.prototype) as TimetableService;
    Object.assign(svc, {
      db: { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) },
      audit: { record: jest.fn() },
      cover: { announceCoverWithdrawn: announce },
    });
    return { svc, announce, tx };
  }

  it("tells everyone whose cover went with it", async () => {
    const { svc, announce } = makeTimetable([
      { coveringTeacherId: "t1", date: new Date("2026-12-01") },
      { coveringTeacherId: "t2", date: new Date("2026-12-08") },
    ]);
    await svc.deleteEntry(staff, "e1");
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("uses the same notice as an explicit removal", async () => {
    // Two wordings for one event is how a reliever ends up unsure which of them
    // is the real state.
    const { svc, announce } = makeTimetable([{ coveringTeacherId: "t1", date: new Date("2026-12-01") }]);
    await svc.deleteEntry(staff, "e1");
    expect(announce.mock.calls[0][1]).toMatchObject({ coveringTeacherId: "t1", subject: "Maths", className: "JSS1 A" });
  });

  it("asks only about cover still AHEAD", async () => {
    // A cover date that has passed is history; announcing it is noise on the one
    // channel that has to stay worth reading.
    const { svc, tx } = makeTimetable([]);
    await svc.deleteEntry(staff, "e1");
    expect((tx.lessonCover.findMany as jest.Mock).mock.calls[0][0].where.date).toHaveProperty("gte");
  });

  it("records how many assignments the cascade removed", async () => {
    // "It cascades" is a fact about the database, not an answer to "where did
    // those go" a term later.
    const { svc } = makeTimetable([{ coveringTeacherId: "t1", date: new Date("2026-12-01") }]);
    const audit = (svc as unknown as { audit: { record: jest.Mock } }).audit;
    await svc.deleteEntry(staff, "e1");
    expect(JSON.stringify(audit.record.mock.calls)).toMatch(/coverAssignmentsRemoved/);
  });

  it("says nothing when nobody was covering it", async () => {
    const { svc, announce } = makeTimetable([]);
    await svc.deleteEntry(staff, "e1");
    expect(announce).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

import { ExamService } from "../../src/exam/exam.service";

/** The exam half of the same asymmetry. */
function makeExam(roster: Array<{ staffId: string }>, seats = 0) {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const tx = {
    examSitting: {
      findFirst: jest.fn().mockResolvedValue({
        title: "Maths Paper 1",
        date: new Date("2026-12-04"),
        startsAt: "09:00",
        hall: "Hall A",
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    examInvigilator: {
      findMany: jest.fn().mockResolvedValue(roster),
      deleteMany: jest.fn().mockResolvedValue({ count: roster.length || 1 }),
    },
    examSeat: { count: jest.fn().mockResolvedValue(seats) },
  } as unknown as TenantTx;
  const svc = Object.create(ExamService.prototype) as ExamService;
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) },
    audit: { record: jest.fn() },
    notifications: { enqueue },
  });
  return { svc, enqueue, tx };
}

describe("cancelling an exam somebody was rostered for", () => {
  it("tells every invigilator", async () => {
    const { svc, enqueue } = makeExam([{ staffId: "s1" }, { staffId: "s2" }], 30);
    await svc.deleteSitting(staff, "sit1");
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect((enqueue.mock.calls[0][1] as { body: string }).body).toMatch(/Maths Paper 1 on 2026-12-04 at 09:00 \(Hall A\)/);
  });

  it("reads the roster BEFORE the cascade takes it", async () => {
    // deleteMany cascades seats and invigilators; asked afterwards, there is
    // nobody left to tell.
    const { svc, tx } = makeExam([{ staffId: "s1" }]);
    await svc.deleteSitting(staff, "sit1");
    const order = [
      (tx.examInvigilator.findMany as jest.Mock).mock.invocationCallOrder[0],
      (tx.examSitting.deleteMany as jest.Mock).mock.invocationCallOrder[0],
    ];
    expect(order[0]).toBeLessThan(order[1]);
  });

  it("records what went with it", async () => {
    // Thirty seats and two duties disappeared and the audit row said nothing at
    // all — not even how many.
    const { svc } = makeExam([{ staffId: "s1" }, { staffId: "s2" }], 30);
    const audit = (svc as unknown as { audit: { record: jest.Mock } }).audit;
    await svc.deleteSitting(staff, "sit1");
    expect(audit.record.mock.calls[0][0].metadata).toEqual({ seatsDeleted: 30, invigilatorsRemoved: 2 });
  });

  it("tells one invigilator when they alone are taken off", async () => {
    const { svc, enqueue } = makeExam([{ staffId: "s1" }]);
    await svc.removeInvigilator(staff, "sit1", "s1");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((enqueue.mock.calls[0][1] as { title: string }).title).toMatch(/no longer invigilating/);
  });

  it("says nothing when the sitting had no roster", async () => {
    const { svc, enqueue } = makeExam([], 0);
    await svc.deleteSitting(staff, "sit1");
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

import { DutyService } from "../../src/hr/duty.service";

/** The third instance of the same asymmetry: the duty roster. */
function makeDuty(row: Record<string, unknown> | null) {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const tx = {
    dutyAssignment: {
      findFirst: jest.fn().mockResolvedValue(row),
      delete: jest.fn().mockResolvedValue({}),
    },
  } as unknown as TenantTx;
  const svc = Object.create(DutyService.prototype) as DutyService;
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) },
    audit: { record: jest.fn() },
    notifications: { enqueue },
  });
  return { svc, enqueue };
}

const GATE = {
  id: "d1",
  userId: "t1",
  title: "Gate",
  date: new Date("2026-12-05T00:00:00.000Z"),
  startTime: "07:30",
  endTime: "08:15",
  note: null,
};

describe("taking a rostered duty off somebody", () => {
  it("tells them, naming the duty and the day", async () => {
    const { svc, enqueue } = makeDuty(GATE);
    await svc.remove(staff, "d1");
    const msg = enqueue.mock.calls[0][1] as { recipientId: string; title: string; body: string };
    expect(msg.recipientId).toBe("t1");
    expect(msg.title).toBe("Duty cancelled: Gate");
    expect(msg.body).toMatch(/no longer on Gate at 07:30–08:15 on 2026-12-05/);
  });

  it("reads the row before deleting it", async () => {
    const { svc, enqueue } = makeDuty(GATE);
    await svc.remove(staff, "d1");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("names the day in UTC, because a duty date is a DAY", async () => {
    // `date` is a @db.Date and serialises as midnight UTC. Formatting it in a
    // zone west of UTC names the PREVIOUS day — on a cancellation notice that
    // stands somebody down from the wrong shift.
    const { svc, enqueue } = makeDuty({ ...GATE, date: new Date("2026-12-05T00:00:00.000Z") });
    await svc.remove(staff, "d1");
    expect((enqueue.mock.calls[0][1] as { body: string }).body).toMatch(/2026-12-05/);
  });

  it("still removes the duty when the notice cannot be sent", async () => {
    const { svc } = makeDuty(GATE);
    (svc as unknown as { notifications: { enqueue: jest.Mock } }).notifications.enqueue = jest
      .fn()
      .mockRejectedValue(new Error("mail down"));
    await expect(svc.remove(staff, "d1")).resolves.toEqual({ deleted: true });
  });

  it("says nothing about a duty that was not there", async () => {
    const { svc, enqueue } = makeDuty(null);
    await expect(svc.remove(staff, "nope")).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
