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
    // The register is written as ONE bulk upsert (INSERT … ON CONFLICT), not a
    // per-student upsert loop — see AttendanceService.markAttendance.
    $executeRaw: jest.fn().mockResolvedValue(1),
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { enqueue: jest.fn().mockResolvedValue({ id: "n-1" }) };
  const service = new AttendanceService(db as never, audit as never, notifications as never);
  return { service, tx, audit, notifications };
}

const principal = (roles: string[], userId = "u-1"): Principal => ({
  schoolId: "school-A",
  userId,
  roles,
  permissions: [],
});

describe("AttendanceService scoping", () => {
  it("a teacher of the class can mark enrolled students", async () => {
    const { service, audit } = makeService({
      classRow: { id: "c-1" },
      classTeacher: { id: "ct-1" },
      enrollmentRows: [{ studentId: "stu-1" }],
    });
    await service.markAttendance(principal(["teacher"]), "c-1", {
      date: "2026-06-20",
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
      date: "2026-06-20",
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
      date: "2026-06-20",
      records: [{ studentId: "stu-1", status: "PRESENT" }],
    });
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });

  it("a teacher who doesn't teach the class gets 404", async () => {
    const { service } = makeService({ classRow: { id: "c-1" }, classTeacher: null });
    await expect(
      service.markAttendance(principal(["teacher"]), "c-1", {
        date: "2026-06-20",
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
        date: "2026-06-20",
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
