// =============================================================================
// AttendanceService — relationship-scoping unit tests (in-memory fakes, no DB)
// =============================================================================

import { AttendanceService } from "../../src/attendance/attendance.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

interface Fakes {
  classRow?: { id: string } | null;
  classTeacher?: { id: string } | null; // is caller a teacher of the class?
  enrollmentRows?: { studentId: string }[]; // enrolled in the class
  parentChild?: { id: string } | null;
  guardianLinks?: { parentId: string; studentId: string }[];
  classTeacherMany?: { classId: string }[];
  enrollmentForStudent?: { id: string } | null;
  currentTerm?: { startDate: Date | null } | null;
}

function makeService(f: Fakes) {
  const session = { id: "sess-1" };
  const tx = {
    class: { findFirst: jest.fn().mockResolvedValue(f.classRow ?? null) },
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
    },
    term: { findFirst: jest.fn().mockResolvedValue(f.currentTerm ?? null) },
    // The register is written as ONE bulk upsert (INSERT … ON CONFLICT), not a
    // per-student upsert loop — see AttendanceService.markAttendance.
    $executeRaw: jest.fn().mockResolvedValue(1),
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { enqueue: jest.fn().mockResolvedValue({ id: "n-1" }) };
  const workflow = { createRequest: jest.fn().mockResolvedValue({ id: "wf-1" }), submit: jest.fn().mockResolvedValue({ id: "wf-1" }) };
  const hooks = { onFinalized: jest.fn() };
  const service = new AttendanceService(db as never, audit as never, notifications as never, workflow as never, hooks as never);
  return { service, tx, audit, notifications, workflow, hooks };
}

const principal = (roles: string[], userId = "u-1"): Principal => ({
  schoolId: "school-A",
  userId,
  roles,
  permissions: [],
});

const recent = () => new Date().toISOString().slice(0, 10);

describe("AttendanceService scoping", () => {
  it("a teacher of the class can mark enrolled students", async () => {
    const { service, audit } = makeService({
      classRow: { id: "c-1" },
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

  it("marking ABSENT notifies the student's guardians", async () => {
    const { service, notifications } = makeService({
      classRow: { id: "c-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "stu-1" }],
      guardianLinks: [{ parentId: "dad-1", studentId: "stu-1" }],
    });
    await service.markAttendance(principal(["teacher"]), "c-1", {
      date: recent(),
      records: [{ studentId: "stu-1", status: "ABSENT" }],
    });
    expect(notifications.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recipientId: "dad-1", type: "ATTENDANCE_ABSENCE" }),
    );
  });

  it("marking PRESENT does NOT notify guardians", async () => {
    const { service, notifications } = makeService({
      classRow: { id: "c-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "stu-1" }],
      guardianLinks: [{ parentId: "dad-1", studentId: "stu-1" }],
    });
    await service.markAttendance(principal(["teacher"]), "c-1", {
      date: recent(),
      records: [{ studentId: "stu-1", status: "PRESENT" }],
    });
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });

  it("a teacher who doesn't teach the class gets 404", async () => {
    const { service } = makeService({ classRow: { id: "c-1" }, classTeacher: null });
    await expect(
      service.markAttendance(principal(["teacher"]), "c-1", {
        date: recent(),
        records: [{ studentId: "stu-1", status: "PRESENT" }],
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("marking a non-enrolled student is rejected (400)", async () => {
    const { service } = makeService({
      classRow: { id: "c-1" },
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
      classRow: { id: "c-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "s-1" }],
      currentTerm: { startDate: new Date("2026-05-01") }, // term starts AFTER the register date
    });
    await expect(service.markAttendance(teacher, "c-1", rec)).rejects.toMatchObject({ status: 409 });
  });

  it("ALLOWS marking a register within the current term", async () => {
    const { service } = makeService({
      classRow: { id: "c-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "s-1" }],
      currentTerm: { startDate: new Date("2026-01-01") }, // register date is within the term
    });
    await expect(service.markAttendance(teacher, "c-1", rec)).resolves.toBeDefined();
  });

  it("FAIL-OPEN: no term configured -> no lock, marking allowed", async () => {
    const { service } = makeService({
      classRow: { id: "c-1" },
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
      classRow: { id: "c-1" },
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
      classRow: { id: "c-1" },
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
      classRow: { id: "c-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "s-1" }],
      currentTerm: { startDate: null },
    });
    await service.markAttendance(principal(["teacher"]), "c-1", rec(new Date().toISOString().slice(0, 10)));
    expect(workflow.createRequest).not.toHaveBeenCalled();
  });
});
