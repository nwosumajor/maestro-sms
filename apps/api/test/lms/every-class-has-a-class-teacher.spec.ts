/**
 * EVERY CLASS HAS A CLASS TEACHER, AND THEY ARE A REAL MEMBER OF STAFF.
 *
 * The class teacher, the form teacher and the class supervisor are one person:
 * they take the class register and answer for the class. Subject teachers are a
 * different relationship — eleven subjects to one class, eleven people, none of
 * them taking the register.
 *
 * Measured before this: of 31 classes, 0 had a supervisor, 1 had a class_teacher
 * row and 30 had NEITHER. A class could be created with nobody responsible for
 * its register, and `updateClass` would happily clear the one it had.
 *
 * Two gaps this closes:
 *   - a class created with no class teacher at all
 *   - a class teacher who is a PUPIL or has LEFT — `updateClass` asked only
 *     that the id resolved to a user, which a pupil does
 */
import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const admin: Principal = { schoolId: "A", userId: "adm", roles: ["school_admin"], permissions: ["class.write"] };

function harness(opts: {
  /** roles of the person being named as class teacher */
  roles?: string[];
  status?: string;
  /** the class's current class teacher, for the update path */
  currentSupervisor?: string | null;
} = {}) {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const tx = {
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    class: {
      // HONOURS THE WHERE: create asks "is this name taken" and update asks
      // "which class is this". A stub answering both with a row made the create
      // path a duplicate-name conflict before it ever reached the rule.
      findFirst: jest.fn((args: { where?: { name?: unknown; id?: unknown } }) =>
        Promise.resolve(
          args?.where?.name
            ? null
            : { id: "c1", name: "SS1A", supervisorId: opts.currentSupervisor ?? null },
        ),
      ),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve({ id: "c1", ...args.data });
      }),
      update: jest.fn((args: { data: Record<string, unknown> }) => {
        updated.push(args.data);
        return Promise.resolve({ id: "c1", ...args.data });
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: "t1", name: "James Adams", status: opts.status ?? "ACTIVE" }),
    },
    userRole: {
      findMany: jest.fn().mockResolvedValue((opts.roles ?? ["teacher"]).map((name) => ({ role: { name } }))),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  return { svc: new LmsService(db as never, { record: jest.fn() } as never), created, updated };
}

const NEW_CLASS = { name: "SS1A", supervisorId: "t1" };

describe("every class has a class teacher", () => {
  it("creates the class WITH them, so a register is never nobody's job", async () => {
    const { svc, created } = harness();
    await svc.createClass(admin, NEW_CLASS);
    expect(created[0].supervisorId).toBe("t1");
  });

  it("refuses a PUPIL as the class teacher", async () => {
    // The old check asked only that the id resolved to a user — which a pupil
    // does. A child cannot be responsible for their class's register.
    const { svc, created } = harness({ roles: ["student"] });
    await expect(svc.createClass(admin, NEW_CLASS)).rejects.toThrow(/not a member of staff/i);
    expect(created).toEqual([]);
  });

  it("refuses somebody who has LEFT the school", async () => {
    // A class handed to a leaver has no teacher, and the screen says it does —
    // the same rule every other duty in this product already applies.
    const { svc, created } = harness({ status: "EXITED" });
    await expect(svc.createClass(admin, NEW_CLASS)).rejects.toThrow();
    expect(created).toEqual([]);
  });
});

describe("a class teacher is changed, never removed", () => {
  it("refuses clearing the class teacher of a class that has one", async () => {
    const { svc, updated } = harness({ currentSupervisor: "t-old" });
    await expect(svc.updateClass(admin, "c1", { supervisorId: null })).rejects.toThrow(
      /must have a class teacher/i,
    );
    expect(updated).toEqual([]);
  });

  it("allows handing the class over to somebody else", async () => {
    // The half that must not be traded away: replacing is how a school moves a
    // class on, and refusing that would freeze every assignment ever made.
    const { svc, updated } = harness({ currentSupervisor: "t-old" });
    await svc.updateClass(admin, "c1", { supervisorId: "t1" });
    expect(updated[0].supervisorId).toBe("t1");
  });

  it("still lets a class that has NONE yet be left alone", async () => {
    // 30 of 31 classes are in exactly that state. Refusing a null here would
    // block every unrelated edit to them until somebody is found.
    const { svc, updated } = harness({ currentSupervisor: null });
    await svc.updateClass(admin, "c1", { supervisorId: null });
    expect(updated).toHaveLength(1);
  });
});
