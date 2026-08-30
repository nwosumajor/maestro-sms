// =============================================================================
// LmsService — lifecycle enhancements unit tests
// =============================================================================
// Proves capacity enforcement on enrollment, the transfer/withdraw status setter,
// the eligibility SIGNAL aggregation (avg score + attendance %), and member-scoped
// class info (404 to non-members).

import { ConflictException, NotFoundException } from "@nestjs/common";
import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function svc(over: Record<string, unknown>) {
  const tx = {
    // The capacity check locks the class row first, so the count and the insert
    // are atomic — the same guard hostel allocation uses for a bed.
    $executeRaw: jest.fn().mockResolvedValue(1),
    class: { findFirst: jest.fn().mockResolvedValue(over.cls ?? null), findMany: jest.fn().mockResolvedValue([]) },
    enrollment: {
      count: jest.fn().mockResolvedValue(over.activeCount ?? 0),
      create: jest.fn().mockResolvedValue({ id: "en" }),
      findFirst: jest.fn().mockResolvedValue(over.enrollment ?? null),
      findMany: jest.fn().mockResolvedValue(over.enrolled ?? []),
      update: jest.fn((a: { data: Record<string, unknown> }) => Promise.resolve({ id: "en", ...a.data })),
    },
    classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue(over.subjects ?? []) },
    parentChild: { findMany: jest.fn().mockResolvedValue([]) },
    grade: { findMany: jest.fn().mockResolvedValue(over.grades ?? []) },
    attendanceRecord: { findMany: jest.fn().mockResolvedValue(over.attendance ?? []) },
    user: {
      findFirst: jest.fn().mockResolvedValue(over.supervisor ?? null),
      // enrollStudent now verifies the pupil is on roll in THIS school before
      // it writes anything (#248). Both reads answer with the pupil under test.
      findMany: jest.fn().mockResolvedValue(over.students ?? [{ id: "s1", name: "A Pupil" }]),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new LmsService(db as never, audit as never), tx };
}

// enrollment.read is load-bearing now: the whole-school view of pupils BY NAME
// (roster, eligibility) needs the role AND the grant, which is what keeps
// `board` — class.read but deliberately not enrollment.read — from being served
// every child. school_admin holds it in the seed.
const admin: Principal = {
  schoolId: "A", userId: "a1", roles: ["school_admin"], permissions: ["enrollment.read"],
};
const student = (id: string): Principal => ({ schoolId: "A", userId: id, roles: ["student"], permissions: [] });

describe("LmsService lifecycle", () => {
  it("enrollStudent refuses when the class is at capacity", async () => {
    const { service } = svc({ cls: { id: "c1", capacity: 2 }, activeCount: 2 });
    await expect(service.enrollStudent(admin, "c1", "s1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("enrollStudent succeeds with capacity headroom", async () => {
    const { service, tx } = svc({ cls: { id: "c1", capacity: 30 }, activeCount: 10 });
    await service.enrollStudent(admin, "c1", "s1");
    const enr = tx.enrollment as unknown as { create: jest.Mock };
    expect(enr.create).toHaveBeenCalled();
  });

  it("setEnrollmentStatus records a transfer with reason", async () => {
    // activeCount = the pupil's OTHER active enrolments. They are in another
    // class, so taking them off this list is a roster correction and allowed.
    const { service, tx } = svc({ enrollment: { id: "en1" }, activeCount: 1 });
    await service.setEnrollmentStatus(admin, "c1", "s1", "TRANSFERRED", "moved town");
    const enr = tx.enrollment as unknown as { update: jest.Mock };
    expect(enr.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "TRANSFERRED", statusReason: "moved town" } }),
    );
  });

  it("setEnrollmentStatus REFUSES to take a pupil out of their last class", async () => {
    // Their only class. Removing it drops them from every register and print
    // run while their account stays ACTIVE and they can still sign in — an exit
    // done by one person, with none of an exit's guarantees. `enrollment.write`
    // is held by junior_admin, the tier defined by having no approval powers.
    // Leaving the school is the two-stage STUDENT_EXIT workflow instead.
    const { service, tx } = svc({ enrollment: { id: "en1" }, activeCount: 0 });
    await expect(
      service.setEnrollmentStatus(admin, "c1", "s1", "WITHDRAWN", "left"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((tx.enrollment as unknown as { update: jest.Mock }).update).not.toHaveBeenCalled();
  });

  it("still lets a pupil be put BACK into a class they are their only enrolment in", async () => {
    // The refusal is about removal. Reactivating is the safe direction and must
    // not be caught by it, or a mistake becomes unfixable.
    const { service, tx } = svc({ enrollment: { id: "en1" }, cls: { id: "c1", capacity: null }, activeCount: 0 });
    await service.setEnrollmentStatus(admin, "c1", "s1", "ACTIVE");
    expect((tx.enrollment as unknown as { update: jest.Mock }).update).toHaveBeenCalled();
  });

  it("eligibility computes avg score (%) and attendance (%) per student", async () => {
    const { service } = svc({
      cls: { id: "c1" },
      enrolled: [{ studentId: "s1", student: { id: "s1", name: "Ada" } }],
      grades: [
        { score: 8, maxScore: 10, submission: { studentId: "s1" } }, // 80
        { score: 6, maxScore: 10, submission: { studentId: "s1" } }, // 60 -> avg 70
      ],
      attendance: [
        { status: "PRESENT", studentId: "s1" },
        { status: "ABSENT", studentId: "s1" },
        { status: "LATE", studentId: "s1" },
        { status: "PRESENT", studentId: "s1" }, // 3/4 attended = 75%
      ],
    });
    const res = await service.getClassEligibility(admin, "c1");
    expect(res[0]).toMatchObject({ studentId: "s1", averageScore: 70, attendancePercent: 75 });
  });

  it("getClassInfo 404s for a non-member student", async () => {
    const { service } = svc({ cls: { id: "c1", supervisorId: null }, enrollment: null });
    await expect(service.getClassInfo(student("nobody"), "c1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("getClassInfo returns subjects+supervisor for an enrolled student", async () => {
    const { service } = svc({
      cls: { id: "c1", supervisorId: "sup1" },
      class: { findMany: jest.fn().mockResolvedValue([]) },
      classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
      enrollment: { id: "en1" }, // student is enrolled
      subjects: [{ subject: { name: "Maths" }, teacher: { name: "Mr A" } }],
      supervisor: { name: "Ms Super" },
    });
    const info = await service.getClassInfo(student("s1"), "c1");
    expect(info.supervisorName).toBe("Ms Super");
    expect(info.subjects).toEqual([{ subjectName: "Maths", teacherName: "Mr A" }]);
  });
});
