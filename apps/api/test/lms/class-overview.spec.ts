// =============================================================================
// LmsService.listClassOverview — the figures the classes page is managed by
// =============================================================================
// The page used to render a class name and its raw UUID, which answers no question
// a head of school has. These are the numbers that replaced it, and the two things
// worth pinning down are that they are GROUPED (never one query per class) and
// that the roll counts ACTIVE enrolments only — a roll that included promoted and
// withdrawn pupils would make capacity meaningless, and it would disagree with the
// billing seat count.
// =============================================================================

import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const admin: Principal = { schoolId: "A", userId: "u1", roles: ["school_admin"], permissions: [] };

const CLASSES = [
  { id: "c1", name: "JSS1A", code: "JSS1A", level: 1, capacity: 30, nextClassId: "c2", supervisorId: "t1" },
  { id: "c2", name: "JSS2A", code: "JSS2A", level: 2, capacity: 25, nextClassId: null, supervisorId: null },
];

function makeService() {
  const tx = {
    class: { findMany: jest.fn().mockResolvedValue(CLASSES) },
    enrollment: {
      groupBy: jest.fn().mockResolvedValue([
        { classId: "c1", _count: { _all: 28 } },
        { classId: "c2", _count: { _all: 31 } },
      ]),
    },
    classTeacher: { groupBy: jest.fn().mockResolvedValue([{ classId: "c1", _count: { _all: 2 } }]) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "t1", name: "Mrs Bello" }]) },
    // The subject COUNT now comes from reading the offerings themselves — the
    // same query that supplies who teaches what — so the raw COUNT is gone.
    classSubjectTeacher: {
      findMany: jest.fn().mockResolvedValue([
        { classId: "c1", subjectId: "s1", teacherId: "t1" },
        { classId: "c1", subjectId: "s2", teacherId: "t1" },
      ]),
    },
    subject: {
      findMany: jest.fn().mockResolvedValue([
        { id: "s1", name: "English" },
        { id: "s2", name: "Mathematics" },
      ]),
    },
  };
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
  };
  return { service: new LmsService(db as never, { record: jest.fn() } as never), tx };
}

describe("LmsService.listClassOverview", () => {
  it("attaches roll, capacity, supervisor and teaching counts to each class", async () => {
    const { service } = makeService();
    const rows = await service.listClassOverview(admin);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "c1",
      name: "JSS1A",
      students: 28,
      capacity: 30,
      teachers: 2,
      subjects: 2,
      supervisorName: "Mrs Bello",
    });
    // A class with nothing recorded reads as zero, not as absent — and a class with
    // no form teacher is named as such rather than left blank, because that is the
    // condition somebody has to act on.
    expect(rows[1]).toMatchObject({ id: "c2", students: 31, teachers: 0, subjects: 0, supervisorName: null });
  });

  it("counts ACTIVE enrolments only", async () => {
    // A promoted or withdrawn pupil is not in the room. Counting them would make
    // "28 of 30" meaningless and would drift from the billing seat count, which is
    // the platform's one definition of a student.
    const { service, tx } = makeService();
    await service.listClassOverview(admin);
    expect(tx.enrollment.groupBy.mock.calls[0][0].where).toMatchObject({ status: "ACTIVE" });
  });

  it("uses GROUPED queries — never one per class", async () => {
    // The whole reason the page can carry these numbers at all. A per-class loop
    // would be invisible at six classes and painful at sixty, which is exactly the
    // school that needs the page most.
    const { service, tx } = makeService();
    await service.listClassOverview(admin);
    expect(tx.enrollment.groupBy).toHaveBeenCalledTimes(1);
    expect(tx.classTeacher.groupBy).toHaveBeenCalledTimes(1);
    expect(tx.classSubjectTeacher.findMany).toHaveBeenCalledTimes(1);
    expect(tx.subject.findMany).toHaveBeenCalledTimes(1);
    // One lookup for every supervisor, not one per class.
    expect(tx.user.findMany).toHaveBeenCalledTimes(1);
  });

  it("does no work at all when the caller sees no classes", async () => {
    const { service, tx } = makeService();
    tx.class.findMany.mockResolvedValue([]);
    await expect(service.listClassOverview(admin)).resolves.toEqual([]);
    expect(tx.enrollment.groupBy).not.toHaveBeenCalled();
  });
});
