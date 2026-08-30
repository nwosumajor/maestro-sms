/**
 * A CLASS TEACHER IS THE CLASS SUPERVISOR.
 *
 * They are one person and one job: the teacher who runs a class, takes its
 * register and answers for it. Subject teaching is a different relationship —
 * SS1A offers eleven subjects taught by eleven different people, each owning
 * that subject's syllabus, assessments and marks, none of them taking the
 * register.
 *
 * The platform stored the first concept TWICE:
 *
 *   class.supervisorId     single, nullable   — READ by attendance
 *   class_teacher          many-to-many       — WRITTEN by "assign teacher"
 *
 * and the visible action wrote only the second. So a school assigned a class
 * teacher through the product and that person could not take their own
 * register. Proven live on History 101, whose assigned teacher got:
 *
 *   403 "Only History 101's supervisor takes its register — ask a school
 *        administrator to cover it"
 *
 * Measured at the same time: of 31 classes, 0 had a supervisor, 1 had a
 * class_teacher row, and 30 had NEITHER — so the rule "every class has a class
 * teacher" was neither met nor enforceable.
 */
import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const admin: Principal = { schoolId: "A", userId: "adm", roles: ["school_admin"], permissions: ["class.write"] };

function harness(supervisorId: string | null = null) {
  const cls = { id: "c1", name: "SS1A", supervisorId };
  const calls: Array<{ op: string; args: unknown }> = [];
  const tx = {
    class: {
      findFirst: jest.fn().mockResolvedValue(cls),
      update: jest.fn((args: { data: { supervisorId: string } }) => {
        calls.push({ op: "class.update", args });
        cls.supervisorId = args.data.supervisorId;
        return Promise.resolve(cls);
      }),
      updateMany: jest.fn((args: { where: { supervisorId?: string } }) => {
        calls.push({ op: "class.updateMany", args });
        if (args.where.supervisorId === cls.supervisorId) cls.supervisorId = null;
        return Promise.resolve({ count: 1 });
      }), findMany: jest.fn().mockResolvedValue([]) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "t1", name: "James Adams", status: "ACTIVE" }) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  return { svc: new LmsService(db as never, { record: jest.fn() } as never), cls, calls, tx };
}

describe("a class teacher can take their own register", () => {
  it("assigning one makes them the SUPERVISOR, which is what attendance reads", async () => {
    const { svc, cls } = harness(null);
    await svc.assignTeacher(admin, "c1", "t1");
    expect(cls.supervisorId).toBe("t1");
  });

  it("assigning REPLACES — a class has one class teacher, not a list", async () => {
    // The join table was many-to-many and `supervisorId` is not; the shape of
    // the surviving column IS the rule, so there is nothing to sweep.
    const { svc, cls } = harness("someone-else");
    await svc.assignTeacher(admin, "c1", "t1");
    expect(cls.supervisorId).toBe("t1");
  });

  it("removal is REFUSED — a class is handed over, never left empty", async () => {
    // While this was a join row the last removal left a class whose register
    // was nobody's job. Every class must have a class teacher, so the way to
    // take somebody off is to put somebody else on.
    const { svc, cls } = harness("t1");
    await expect(svc.removeTeacher(admin, "c1", "t1")).rejects.toThrow(/must have a class teacher/i);
    expect(cls.supervisorId).toBe("t1");
  });

  it("404s for somebody who is not this class's teacher", async () => {
    // Same answer whether the class or the assignment is missing — never
    // disclose which.
    const { svc } = harness("t1");
    await expect(svc.removeTeacher(admin, "c1", "someone-else")).rejects.toThrow(/not assigned to this class/i);
  });
});
