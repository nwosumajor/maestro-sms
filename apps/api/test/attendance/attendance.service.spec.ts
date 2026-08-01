// =============================================================================
// AttendanceService — relationship-scoping unit tests (in-memory fakes, no DB)
// =============================================================================

import { schoolToday } from "@sms/types";
import { AttendanceService } from "../../src/attendance/attendance.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

interface Fakes {
  classRow?: { id: string; supervisorId?: string | null } | null;
  classTeacher?: { id: string } | null; // is caller a teacher of the class?
  enrollmentRows?: { studentId: string }[]; // enrolled in the class
  parentChild?: { id: string } | null;
  guardianLinks?: { parentId: string; studentId: string }[];
  classTeacherMany?: { classId: string }[];
  enrollmentForStudent?: { id: string } | null;
  currentTerm?: { startDate: Date | null } | null;
  holidays?: { name: string; startDate: Date; endDate: Date }[];
  /** Where the school IS. Defaults to the platform's home zone, so every existing
   *  test keeps asserting exactly what it asserted before. */
  timezone?: string;
}

function makeService(f: Fakes) {
  const session = { id: "sess-1" };
  const tx = {
    class: { findFirst: jest.fn().mockResolvedValue(f.classRow ?? null), findMany: jest.fn().mockResolvedValue([]) },
    classTeacher: {
      findFirst: jest.fn().mockResolvedValue(f.classTeacher ?? null),
      findMany: jest.fn().mockResolvedValue(f.classTeacherMany ?? []),
    },
    enrollment: {
      findMany: jest.fn().mockResolvedValue(f.enrollmentRows ?? []),
      findFirst: jest.fn().mockResolvedValue(f.enrollmentForStudent ?? null),
    },
    parentChild: {
      findFirst: jest.fn().mockResolvedValue(f.parentChild ?? null),
      findMany: jest.fn().mockResolvedValue(f.guardianLinks ?? []),
    },
    attendanceSession: {
      upsert: jest.fn().mockResolvedValue(session),
      findFirst: jest.fn().mockResolvedValue({ id: "sess-1", records: [] }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    attendanceRecord: {
      findMany: jest.fn().mockResolvedValue([]),
      // The history is paged, so the TOTAL is counted rather than measured off the
      // returned page — a length is only ever the size of the cap.
      count: jest.fn().mockResolvedValue(0),
    },
    term: { findFirst: jest.fn().mockResolvedValue(f.currentTerm ?? null) },
    schoolHoliday: { findFirst: jest.fn().mockResolvedValue(f.holidays?.[0] ?? null) },
    // The register is written as ONE bulk upsert (INSERT … ON CONFLICT), not a
    // per-student upsert loop — see AttendanceService.markAttendance.
    $executeRaw: jest.fn().mockResolvedValue(1),
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = {
    enqueue: jest.fn().mockResolvedValue({ id: "n-1" }),
    // Guardian alerts go out BATCHED: one call per distinct message with all its
    // recipients, rather than a transaction + queue round-trip per guardian (which
    // meant 40+ sequential awaits on the days a whole class is marked absent).
    enqueueMany: jest.fn().mockResolvedValue({ created: 1, failed: 0 }),
  };
  const workflow = { createRequest: jest.fn().mockResolvedValue({ id: "wf-1" }), submit: jest.fn().mockResolvedValue({ id: "wf-1" }) };
  const hooks = { onFinalized: jest.fn() };
  // The school's region decides what day it is. `f.timezone` lets a test put the
  // school somewhere other than West Africa, which is the whole point of the fix.
  const region = {
    forSchool: jest.fn().mockResolvedValue({ timezone: f.timezone ?? "Africa/Lagos" }),
    inTx: jest.fn().mockResolvedValue({ timezone: f.timezone ?? "Africa/Lagos" }),
    todayInTx: jest.fn(async () => schoolToday(f.timezone ?? "Africa/Lagos")),
  };
  const service = new AttendanceService(
    db as never, audit as never, notifications as never, workflow as never, region as never, hooks as never,
  );
  return { service, tx, audit, notifications, workflow, hooks, region };
}

const principal = (roles: string[], userId = "u-1"): Principal => ({
  schoolId: "school-A",
  userId,
  roles,
  permissions: [],
});

const recent = () => new Date().toISOString().slice(0, 10);

describe("AttendanceService scoping", () => {
  it("the class SUPERVISOR can mark enrolled students", async () => {
    // POLICY CHANGE: teaching a class is no longer enough to take its register.
    // The register records who physically looked at the room, so it follows
    // responsibility for the class, not timetable contact with it.
    const { service, audit } = makeService({
      classRow: { id: "c-1", supervisorId: "u-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "stu-1" }],
    });
    await service.markAttendance(principal(["teacher"]), "c-1", {
      date: recent(),
      records: [{ studentId: "stu-1", status: "PRESENT" }],
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "attendance.mark" }),
      expect.anything(),
    );
  });

  it("refuses to take a register on a school holiday", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const { service } = makeService({
      classRow: { id: "c-1", supervisorId: "u-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "stu-1" }],
      holidays: [{ name: "Mid-term break", startDate: today, endDate: today }],
    });
    await expect(
      service.markAttendance(principal(["teacher"]), "c-1", {
        date: recent(),
        records: [{ studentId: "stu-1", status: "PRESENT" }],
      }),
    ).rejects.toThrow(/holiday/i);
  });

  it("school_admin covers ANY class — the absent-supervisor path", async () => {
    const { service, audit } = makeService({
      classRow: { id: "c-1", supervisorId: "someone-else" },
      classTeacher: null,
      enrollmentRows: [{ studentId: "stu-1" }],
    });
    await service.markAttendance(principal(["school_admin"]), "c-1", {
      date: recent(),
      records: [{ studentId: "stu-1", status: "PRESENT" }],
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "attendance.mark" }),
      expect.anything(),
    );
  });

  it("a SUBJECT teacher of the class can no longer take its register (403)", async () => {
    // They still SEE it — hence 403 rather than 404. A teacher looking at a class
    // they can open would read a 404 as a bug, not as a rule.
    const { service } = makeService({
      classRow: { id: "c-1", supervisorId: "someone-else" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "stu-1" }],
    });
    await expect(
      service.markAttendance(principal(["teacher"]), "c-1", {
        date: recent(),
        records: [{ studentId: "stu-1", status: "PRESENT" }],
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("principal and junior_admin VIEW every register but can no longer write one", async () => {
    // Both held write before. Seniority does not make someone the person who looked
    // at the room; cover is an administrative act with a named owner.
    for (const role of ["principal", "junior_admin"]) {
      const { service } = makeService({
        classRow: { id: "c-1", supervisorId: "someone-else" },
        classTeacher: null,
        enrollmentRows: [{ studentId: "stu-1" }],
      });
      await expect(
        service.markAttendance(principal([role]), "c-1", {
          date: recent(),
          records: [{ studentId: "stu-1", status: "PRESENT" }],
        }),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  it("a class with NO supervisor is takeable only by a cover role", async () => {
    // Otherwise an unsupervised class would have no one able to record it at all.
    const { service } = makeService({
      classRow: { id: "c-1", supervisorId: null },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "stu-1" }],
    });
    await expect(
      service.markAttendance(principal(["teacher"]), "c-1", {
        date: recent(),
        records: [{ studentId: "stu-1", status: "PRESENT" }],
      }),
    ).rejects.toMatchObject({ status: 403 });

    const admin = makeService({
      classRow: { id: "c-1", supervisorId: null },
      classTeacher: null,
      enrollmentRows: [{ studentId: "stu-1" }],
    });
    await expect(
      admin.service.markAttendance(principal(["school_admin"]), "c-1", {
        date: recent(),
        records: [{ studentId: "stu-1", status: "PRESENT" }],
      }),
    ).resolves.toBeTruthy();
  });

  it("marking ABSENT notifies the student's guardians", async () => {
    const { service, notifications } = makeService({
      classRow: { id: "c-1", supervisorId: "u-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "stu-1" }],
      guardianLinks: [{ parentId: "dad-1", studentId: "stu-1" }],
    });
    await service.markAttendance(principal(["teacher"]), "c-1", {
      date: recent(),
      records: [{ studentId: "stu-1", status: "ABSENT" }],
    });
    // The guardian is in the recipient LIST, and the message names the status.
    expect(notifications.enqueueMany).toHaveBeenCalledWith(
      expect.anything(),
      ["dad-1"],
      expect.objectContaining({ type: "ATTENDANCE_ABSENCE" }),
    );
  });

  it("marking PRESENT does NOT notify guardians", async () => {
    const { service, notifications } = makeService({
      classRow: { id: "c-1", supervisorId: "u-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "stu-1" }],
      guardianLinks: [{ parentId: "dad-1", studentId: "stu-1" }],
    });
    await service.markAttendance(principal(["teacher"]), "c-1", {
      date: recent(),
      records: [{ studentId: "stu-1", status: "PRESENT" }],
    });
    expect(notifications.enqueue).not.toHaveBeenCalled();
    expect(notifications.enqueueMany).not.toHaveBeenCalled();
  });

  it("a teacher with NO relationship to the class still gets 404, not 403", async () => {
    // 404 vs 403 is the disclosure boundary: a stranger must not learn the class
    // exists, whereas someone who can already see it gets told the rule (403).
    const { service } = makeService({ classRow: { id: "c-1", supervisorId: "someone-else" }, classTeacher: null });
    await expect(
      service.markAttendance(principal(["teacher"]), "c-1", {
        date: recent(),
        records: [{ studentId: "stu-1", status: "PRESENT" }],
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("marking a non-enrolled student is rejected (400)", async () => {
    const { service } = makeService({
      classRow: { id: "c-1", supervisorId: "u-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "stu-1" }],
    });
    await expect(
      service.markAttendance(principal(["teacher"]), "c-1", {
        date: recent(),
        records: [{ studentId: "intruder", status: "ABSENT" }],
      }),
    ).rejects.toThrow(/not enrolled/i);
  });

  it("a parent can read their child's attendance", async () => {
    const { service, tx } = makeService({ parentChild: { id: "link-1" } });
    await service.getStudentAttendance(principal(["parent"]), "child-1");
    expect((tx.attendanceRecord.findMany as jest.Mock)).toHaveBeenCalled();
  });

  it("reports the FULL history size, not the size of the page it returned", async () => {
    // The regression this guards: the history was `take: 200` and nothing else, so
    // a pupil in their fifth year had four years of records that no page could
    // reach and nothing on screen said existed. A count that came from the page
    // would report 100 here and look perfectly healthy.
    const { service, tx } = makeService({});
    (tx.attendanceRecord.count as jest.Mock).mockResolvedValue(940);
    (tx.attendanceRecord.findMany as jest.Mock).mockResolvedValue(new Array(100).fill({ id: "r" }));

    const out = await service.getStudentAttendance(principal(["student"], "stu-self"), "stu-self", { page: 3 });
    expect(out.total).toBe(940);
    expect(out.records).toHaveLength(100);
    // Page 3 must SKIP the first two pages, or "Older" would re-serve page one
    // forever and the earlier years would still be unreachable.
    expect((tx.attendanceRecord.findMany as jest.Mock).mock.calls[0][0]).toMatchObject({ skip: 200, take: 100 });
  });

  it("bounds the page size a caller can ask for", async () => {
    // Otherwise ?pageSize=100000 turns a paged endpoint back into an unbounded one.
    const { service, tx } = makeService({});
    await service.getStudentAttendance(principal(["student"], "stu-self"), "stu-self", { pageSize: 100_000 });
    expect((tx.attendanceRecord.findMany as jest.Mock).mock.calls[0][0].take).toBe(200);
  });

  it("a student reads their OWN attendance", async () => {
    const { service, tx } = makeService({});
    await service.getStudentAttendance(principal(["student"], "stu-self"), "stu-self");
    expect((tx.attendanceRecord.findMany as jest.Mock)).toHaveBeenCalled();
  });

  it("a teacher cannot read attendance of a student they don't teach (404)", async () => {
    const { service } = makeService({
      classTeacherMany: [{ classId: "c-1" }],
      enrollmentForStudent: null,
    });
    await expect(
      service.getStudentAttendance(principal(["teacher"]), "stranger"),
    ).rejects.toThrow(/not found/i);
  });
});

describe("AttendanceService — term lock", () => {
  const teacher = principal(["teacher"], "u-1");
  const rec = { date: "2026-03-10", records: [{ studentId: "s-1", status: "PRESENT" as const }] };

  it("REJECTS marking a register dated before the current term's start", async () => {
    const { service } = makeService({
      classRow: { id: "c-1", supervisorId: "u-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "s-1" }],
      currentTerm: { startDate: new Date("2026-05-01") }, // term starts AFTER the register date
    });
    await expect(service.markAttendance(teacher, "c-1", rec)).rejects.toMatchObject({ status: 409 });
  });

  it("ALLOWS marking a register within the current term", async () => {
    const { service } = makeService({
      classRow: { id: "c-1", supervisorId: "u-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "s-1" }],
      currentTerm: { startDate: new Date("2026-01-01") }, // register date is within the term
    });
    await expect(service.markAttendance(teacher, "c-1", rec)).resolves.toBeDefined();
  });

  it("FAIL-OPEN: no term configured -> no lock, marking allowed", async () => {
    const { service } = makeService({
      classRow: { id: "c-1", supervisorId: "u-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "s-1" }],
      currentTerm: null,
    });
    await expect(service.markAttendance(teacher, "c-1", rec)).resolves.toBeDefined();
  });

  it("getTermLock reports the boundary date", async () => {
    const { service } = makeService({ currentTerm: { startDate: new Date("2026-05-01") } });
    expect(await service.getTermLock(teacher)).toEqual({ lockBeforeDate: "2026-05-01" });
  });
});

describe("AttendanceService — stale-register maker-checker (>7 days)", () => {
  const staleDate = () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 30); // 30 days ago
    return d.toISOString().slice(0, 10);
  };
  const rec = (date: string) => ({ date, records: [{ studentId: "s-1", status: "PRESENT" as const }] });

  it("a TEACHER editing a >7-day register RAISES an amendment (not applied directly)", async () => {
    const { service, workflow, audit } = makeService({
      classRow: { id: "c-1", supervisorId: "u-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "s-1" }],
      currentTerm: { startDate: null }, // no term lock
    });
    const res = await service.markAttendance(principal(["teacher"]), "c-1", rec(staleDate()));
    expect(res).toMatchObject({ pendingApproval: true, requestId: "wf-1" });
    expect(workflow.createRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "ATTENDANCE_AMENDMENT" }),
    );
    // NOT applied directly — no attendance.mark audit.
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "attendance.mark" }),
      expect.anything(),
    );
  });

  it("an APPROVER (attendance.amend.review) edits a >7-day register DIRECTLY", async () => {
    const { service, workflow, audit } = makeService({
      classRow: { id: "c-1", supervisorId: "u-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "s-1" }],
      currentTerm: { startDate: null },
    });
    const approver: Principal = { schoolId: "school-A", userId: "u-2", roles: ["school_admin"], permissions: ["attendance.amend.review"] };
    await service.markAttendance(approver, "c-1", rec(staleDate()));
    expect(workflow.createRequest).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "attendance.mark" }),
      expect.anything(),
    );
  });

  it("a TEACHER editing a RECENT (<=7 day) register applies DIRECTLY", async () => {
    const { service, workflow } = makeService({
      classRow: { id: "c-1", supervisorId: "u-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "s-1" }],
      currentTerm: { startDate: null },
    });
    await service.markAttendance(principal(["teacher"]), "c-1", rec(new Date().toISOString().slice(0, 10)));
    expect(workflow.createRequest).not.toHaveBeenCalled();
  });
});

// =============================================================================
// The register files on the SCHOOL's day, not the server's
// =============================================================================
// This is the defect that made the product unusable outside West Africa without
// anyone noticing: the day a register belongs to was decided in UTC.
// =============================================================================

describe("AttendanceService — school-local dates", () => {
  it("asks the SCHOOL what day it is before deciding a register is stale", async () => {
    // The stale rule is what routes an edit into maker-checker. Measured against
    // the server's UTC day, a register west of UTC counted as a day older than it
    // really was for part of every day — sending an ordinary same-week correction
    // to an approver a day early.
    const { service, region } = makeService({
      classRow: { id: "c-1", supervisorId: "u-1" },
      enrollmentRows: [{ studentId: "stu-1" }],
      timezone: "America/Toronto",
    });
    await service.markAttendance(principal(["teacher"]), "c-1", {
      date: recent(),
      records: [{ studentId: "stu-1", status: "PRESENT" }],
    });
    expect(region.forSchool).toHaveBeenCalledWith("school-A");
  });

  it("defaults the register board to the SCHOOL's today", async () => {
    // getRegisterStatus with no date used the server's UTC day, so a Singapore
    // school opening the board at 07:30 was shown YESTERDAY's registers and told
    // none had been taken.
    const { service, region } = makeService({ timezone: "Asia/Singapore" });
    await service.getRegisterStatus(principal(["school_admin"]));
    expect(region.todayInTx).toHaveBeenCalled();
  });

  it("uses the school's day for the term lock", async () => {
    // The lock boundary is the current term's start. Deciding "which term contains
    // today" in UTC moves the boundary by a day for every school not on UTC.
    const { service, region } = makeService({
      classRow: { id: "c-1", supervisorId: "u-1" },
      enrollmentRows: [{ studentId: "stu-1" }],
      currentTerm: null,
      timezone: "Asia/Dubai",
    });
    await service.markAttendance(principal(["teacher"]), "c-1", {
      date: recent(),
      records: [{ studentId: "stu-1", status: "PRESENT" }],
    });
    // currentTermStart falls back to "the term containing today" when no term is
    // flagged current — and that today must be the school's.
    expect(region.todayInTx).toHaveBeenCalled();
  });
});
