// =============================================================================
// The thirty classes that still had their name on them
// =============================================================================
// Approving a staff exit closes the employment record, recovers loans against
// the settlement, and ends the account's access on the last working day. It says
// nothing about the WORK, and nothing else does either.
//
// The offboarding checklist has a task called "Handover notes". It is a tickbox.
// That is the same shape as "Revoke system access", which for a long time also
// did nothing — a platform that looks like it has handled something while doing
// nothing at all.
//
// On the live database one teacher holds THIRTY class-subject assignments:
//
//   name               class_subject_teacher rows
//   Volume Teacher 14  30
//   Volume Teacher 12  30
//
// When they go, thirty pairings name somebody who cannot sign in, the timetable
// still shows them, and the first symptom is a lesson nobody turns up to.
//
// DATED DUTIES ARE THE URGENT ONES: a cover lesson next Tuesday, an exam they
// are rostered to invigilate, a meeting slot a parent can still book. Somebody
// has to be standing in a room. They sort first for that reason.
//
// NOTHING IS REASSIGNED. The platform cannot know who should take a class, and
// moving thirty assignments to a name it picked is a worse failure than the one
// it fixes. Signals for a human decision — never the decision.
// =============================================================================

import { StaffHandoverService } from "../../src/hr/staff-handover.service";
import type { TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

/** Everything the service asks for, defaulting to "they hold nothing". */
function makeService(rows: Partial<Record<string, unknown[]>> = {}) {
  const table = (key: string) => ({ findMany: jest.fn().mockResolvedValue(rows[key] ?? []) });
  const tx = {
    user: { findFirst: jest.fn().mockResolvedValue({ name: "Ada Obi" }) },
    // The classes they are CLASS TEACHER of, defaulting to none like every
    // other row here. A stub that answered unconditionally would make a leaver
    // who holds nothing hold a class, which is the case this suite opens with.
    // HONOURS THE WHERE, because `class.findMany` now answers two different
    // questions: "which classes do they RUN" (by supervisorId) and "what are
    // these classes called" (by id). A stub answering both the same way either
    // makes a leaver who holds nothing hold a class, or leaves the class it
    // names as a bare id.
    class: {
      findMany: jest.fn(({ where }: { where?: { supervisorId?: string; id?: { in: string[] } } } = {}) =>
        Promise.resolve(
          where?.supervisorId
            ? (rows.classSupervised ?? [])
            : // The school's classes, for naming whatever ids the report holds —
              // a subject assignment names its class too, and it need not be one
              // this person runs.
              [{ id: "c1", name: "JSS1 A" }].filter((c) => where?.id?.in?.includes(c.id)),
        ),
      ),
    },
    classSubjectTeacher: table("classSubjectTeacher"),
    timetableEntry: table("timetableEntry"),
    lessonCover: table("lessonCover"),
    examInvigilator: table("examInvigilator"),
    taskAssignment: table("taskAssignment"),
    disciplineAssignee: table("disciplineAssignee"),
    meetingSlot: table("meetingSlot"),
    hostel: table("hostel"),
    vehicle: table("vehicle"),
    appraisal: table("appraisal"),
    // Question banks they wrote. Not a duty — nobody turns up for a question
    // bank — but the one ASSET on the list, and the school should know it has
    // it before the author stops answering email. Access is never at risk:
    // bank visibility follows the READER's role, so leadership sees every bank
    // whoever wrote it (see a-question-bank-outlives-its-author).
    cbtQuestionBank: table("cbtQuestionBank"),
  } as unknown as TenantTx;
  const svc = Object.create(StaffHandoverService.prototype) as StaffHandoverService;
  Object.assign(svc, {
    db: { runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) },
    region: { forSchool: jest.fn().mockResolvedValue({ timezone: "Africa/Lagos" }) },
  });
  return { svc, tx };
}

/** The service asks its questions of a transaction; hand it one directly. */
const ask = (svc: StaffHandoverService, tx: TenantTx) => svc.dutiesIn(tx, "u1", "Africa/Lagos");

describe("what a departing member of staff is still holding", () => {
  it("says nothing when they hold nothing", async () => {
    const { svc, tx } = makeService();
    const r = await ask(svc, tx);
    expect(r.total).toBe(0);
    expect(r.duties).toEqual([]);
  });

  it("counts the thirty subject assignments the live data actually has", async () => {
    const { svc, tx } = makeService({
      classSubjectTeacher: Array.from({ length: 30 }, () => ({ classId: "c1", subjectId: "s1" })),
    });
    const r = await ask(svc, tx);
    expect(r.total).toBe(30);
    expect(r.duties[0]).toMatchObject({ kind: "SUBJECT_TEACHER", count: 30 });
  });

  it("puts the DATED duties first, whatever their count", async () => {
    // Thirty class assignments are a tidying job. One exam next week is a hall
    // with nobody in it, and it must not sort below them.
    const { svc, tx } = makeService({
      classSubjectTeacher: Array.from({ length: 30 }, () => ({ classId: "c1", subjectId: "s1" })),
      examInvigilator: [{ sitting: { title: "Maths Paper 1", date: new Date("2026-12-01"), hall: "Hall A" } }],
    });
    const r = await ask(svc, tx);
    expect(r.duties[0].kind).toBe("INVIGILATION");
    expect(r.duties[0].dated).toBe(true);
  });

  it("names enough of each to start a handover, without printing all thirty", async () => {
    const { svc, tx } = makeService({
      classSubjectTeacher: Array.from({ length: 30 }, () => ({ classId: "c1", subjectId: "s1" })),
    });
    const r = await ask(svc, tx);
    expect(r.duties[0].detail).toHaveLength(5);
    expect(r.duties[0].detail[0]).toBe("JSS1 A");
  });

  it("drops the categories they hold nothing in", async () => {
    // A report listing eleven headings of zero is a report nobody reads twice.
    const { svc, tx } = makeService({ hostel: [{ name: "Falcon House" }] });
    const r = await ask(svc, tx);
    expect(r.duties.map((d) => d.kind)).toEqual(["HOSTEL"]);
  });

  it("asks only about work still AHEAD for the dated kinds", async () => {
    // A cover lesson last month is history; listing it buries the one next
    // Tuesday. Asserted on the QUERY, since the stub returns whatever it is given.
    const { svc, tx } = makeService();
    await ask(svc, tx);
    const coverWhere = (tx.lessonCover.findMany as jest.Mock).mock.calls[0][0].where;
    expect(coverWhere.date).toHaveProperty("gte");
    const slotWhere = (tx.meetingSlot.findMany as jest.Mock).mock.calls[0][0].where;
    expect(slotWhere.startsAt).toHaveProperty("gte");
  });

  it("ignores work that is already finished", async () => {
    const { svc, tx } = makeService();
    await ask(svc, tx);
    expect((tx.taskAssignment.findMany as jest.Mock).mock.calls[0][0].where.status).toEqual({ not: "DONE" });
    expect((tx.appraisal.findMany as jest.Mock).mock.calls[0][0].where.status).toEqual({ not: "ACKNOWLEDGED" });
  });

  it("covers every kind the DTO declares", async () => {
    // The failure this guards is a new duty table being added and silently not
    // appearing in the handover — the report would still look complete.
    const { svc, tx } = makeService({
      // The class they are CLASS TEACHER of, named so the report can print it.
      classSupervised: [{ id: "c1" }],
      classSubjectTeacher: [{ classId: "c1", subjectId: "s1" }],
      timetableEntry: [{ subject: "Maths", dayOfWeek: "MON" }],
      lessonCover: [{ date: new Date("2026-12-01") }],
      examInvigilator: [{ sitting: { title: "T", date: new Date("2026-12-01"), hall: "H" } }],
      taskAssignment: [{ task: { title: "Fire drill" } }],
      disciplineAssignee: [{ complaint: { subject: "Bullying" } }],
      meetingSlot: [{ startsAt: new Date("2026-12-01T09:00:00Z") }],
      hostel: [{ name: "Falcon" }],
      vehicle: [{ name: "Bus 1" }],
      appraisal: [{ id: "a1" }],
    });
    const r = await ask(svc, tx);
    expect(r.duties).toHaveLength(11);
    expect(r.total).toBe(11);
  });
});

// ---------------------------------------------------------------------------

import { ExitService } from "../../src/hr/exit.service";

/**
 * The exit approval, cut down to the one thing under test: does approving an
 * exit TELL somebody what the leaver is still holding.
 */
function makeExitService(handover: { userName: string; total: number; duties: Array<{ label: string; count: number; dated: boolean }> }) {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const svc = Object.create(ExitService.prototype) as ExitService;
  Object.assign(svc, {
    db: { runAsTenantReadOnly: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn({}) },
    handover: { dutiesIn: jest.fn().mockResolvedValue(handover) },
    notifications: { enqueue },
    region: { forSchool: jest.fn().mockResolvedValue({ timezone: "Africa/Lagos" }) },
    logger: { warn: jest.fn() },
  });
  const tell = (svc as unknown as {
    tellSomebodyWhatIsOutstanding: (p: unknown, userId: string) => Promise<void>;
  }).tellSomebodyWhatIsOutstanding.bind(svc);
  return { tell, enqueue };
}

const approver = { schoolId: "A", userId: "hr-1", roles: ["hr_manager"], permissions: [] };

describe("approving an exit says what is outstanding", () => {
  it("tells the approver, with the counts", async () => {
    const { tell, enqueue } = makeExitService({
      userName: "Ada Obi",
      total: 31,
      duties: [
        { label: "Exams they are rostered to invigilate", count: 1, dated: true },
        { label: "Class subjects they teach", count: 30, dated: false },
      ],
    });
    await tell(approver, "u1");
    expect(enqueue).toHaveBeenCalledTimes(1);
    const msg = enqueue.mock.calls[0][1] as { title: string; body: string; recipientId: string };
    expect(msg.recipientId).toBe("hr-1");
    expect(msg.title).toMatch(/Ada Obi still holds 31 duties/);
    expect(msg.body).toMatch(/Class subjects they teach: 30/);
  });

  it("says that nothing was reassigned, because nothing was", async () => {
    // The failure mode this wording exists for: an approver reading a list and
    // assuming the platform has dealt with it.
    const { tell, enqueue } = makeExitService({
      userName: "Ada Obi",
      total: 2,
      duties: [{ label: "Class subjects they teach", count: 2, dated: false }],
    });
    await tell(approver, "u1");
    expect((enqueue.mock.calls[0][1] as { body: string }).body).toMatch(/Nothing has been reassigned/);
  });

  it("calls out the DATED ones separately", async () => {
    const { tell, enqueue } = makeExitService({
      userName: "Ada Obi",
      total: 4,
      duties: [
        { label: "Cover lessons still to teach", count: 3, dated: true },
        { label: "Vehicles they drive", count: 1, dated: false },
      ],
    });
    await tell(approver, "u1");
    expect((enqueue.mock.calls[0][1] as { body: string }).body).toMatch(/3 of these are DATED/);
  });

  it("says nothing at all when they hold nothing", async () => {
    // A notice that fires on every exit regardless is a notice people learn to
    // ignore, including on the exit where it mattered.
    const { tell, enqueue } = makeExitService({ userName: "Ada Obi", total: 0, duties: [] });
    await tell(approver, "u1");
    expect(enqueue).not.toHaveBeenCalled();
  });
});
