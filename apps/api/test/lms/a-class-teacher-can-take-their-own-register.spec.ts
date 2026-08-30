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
      }),
    },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "t1", name: "James Adams", status: "ACTIVE" }) },
    classTeacher: {
      findFirst: jest.fn().mockResolvedValue({ id: "ct1" }),
      upsert: jest.fn().mockResolvedValue({ id: "ct1", classId: "c1", teacherId: "t1" }),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn((args: unknown) => {
        calls.push({ op: "classTeacher.deleteMany", args });
        return Promise.resolve({ count: 0 });
      }),
    },
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
    // `class_teacher` is many-to-many and `supervisorId` is not; the shape of
    // the surviving column is the rule, so any other row for this class goes.
    const { svc, calls } = harness("someone-else");
    await svc.assignTeacher(admin, "c1", "t1");
    const swept = calls.find((c) => c.op === "classTeacher.deleteMany");
    expect(swept).toBeDefined();
    expect(JSON.stringify(swept!.args)).toContain("t1");
  });

  it("removing the class teacher takes the register with them", async () => {
    // Otherwise the school removes somebody and they keep the one duty that
    // matters — "assigning without revoking is not an assignment".
    const { svc, cls } = harness("t1");
    await svc.removeTeacher(admin, "c1", "t1");
    expect(cls.supervisorId).toBeNull();
  });

  it("removing a DIFFERENT teacher leaves the supervisor alone", async () => {
    // The clear is conditional on it being them: a subject teacher being taken
    // off a class must not silently strip the class teacher's register.
    const { svc, cls } = harness("t1");
    await svc.removeTeacher(admin, "c1", "someone-else");
    expect(cls.supervisorId).toBe("t1");
  });
});
