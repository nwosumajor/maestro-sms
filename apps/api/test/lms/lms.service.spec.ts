// =============================================================================
// LmsService — relationship-scoping unit tests
// =============================================================================
// Proves the RBAC-beyond-role rules with in-memory fakes (no DB):
//  - teacher sees only classes they teach
//  - student sees only classes they're enrolled in
//  - parent sees only their children's classes
//  - school_admin sees all classes in the tenant
//  - a non-member sees none, and roster access for a non-member is 404
// =============================================================================

import { SEARCH_CAP } from "@sms/types";
import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

interface FakeTables {
  classTeacher?: { classId: string }[];
  classSubjectTeacher?: { classId: string }[];
  supervised?: { classId: string }[];
  enrollment?: { classId: string }[];
  enrollmentForChildren?: { classId: string }[];
  parentChild?: { studentId: string }[];
  classRows?: { id: string; name: string }[];
}

function makeService(tables: FakeTables) {
  const allClasses = tables.classRows ?? [];
  const classFindMany = jest.fn(({ where }: { where?: { id?: { in: string[] }; supervisorId?: string } } = {}) => {
    if (where?.id?.in) return Promise.resolve(allClasses.filter((c) => where.id!.in.includes(c.id)));
    // The supervised-classes lookup selects by supervisorId, id only.
    if (where?.supervisorId) return Promise.resolve((tables.supervised ?? []).map((s) => ({ id: s.classId })));
    return Promise.resolve(allClasses); // school-wide
  });
  const enrollmentFindMany = jest.fn(({ where }: { where?: { studentId?: unknown } }) => {
    // parent path queries enrollment by studentId IN [...children]
    if (where && "studentId" in where && typeof where.studentId === "object") {
      return Promise.resolve(tables.enrollmentForChildren ?? []);
    }
    return Promise.resolve(tables.enrollment ?? []);
  });
  const tx = {
  // Capacity checks lock the contended row first (the class / route / slot),
  // so the count and the insert are atomic — the same guard hostel allocation
  // uses for a bed. The mock just has to answer.
  $executeRaw: jest.fn().mockResolvedValue(1),

    class: { findMany: classFindMany, findFirst: jest.fn().mockResolvedValue(null) },
    classTeacher: {
      findMany: jest.fn().mockResolvedValue(tables.classTeacher ?? []),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    classSubjectTeacher: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(tables.classSubjectTeacher ?? []),
    },
    enrollment: { findMany: enrollmentFindMany },
    parentChild: { findMany: jest.fn().mockResolvedValue(tables.parentChild ?? []) },
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new LmsService(db as never, audit as never);
  return { service, classFindMany, tx };
}

/**
 * `permissions` is no longer decorative here.
 *
 * Seeing the whole school's pupils BY NAME needs the role AND the
 * `enrollment.read` grant — the split that stops `board`, which holds class.read
 * and deliberately not enrollment.read, from being served every pupil. Every
 * role these tests drive (school_admin, junior_admin, head_teacher, hr_*) holds
 * it in the seed, so the fixture says so; a caller that genuinely lacks it is
 * exercised by the board case in
 * test/lms/oversight-sees-shape-not-children.spec.ts.
 */
const principal = (roles: string[], permissions: string[] = ["enrollment.read"]): Principal => ({
  schoolId: "school-A",
  userId: "u-1",
  roles,
  permissions,
});

describe("LmsService relationship scoping", () => {
  it("teacher sees only classes they teach", async () => {
    const { service } = makeService({
      classTeacher: [{ classId: "c-taught" }],
      classRows: [{ id: "c-taught", name: "History 101" }],
    });
    const classes = (await service.listMyClasses(principal(["teacher"]))) as { id: string }[];
    expect(classes.map((c) => c.id)).toEqual(["c-taught"]);
  });

  it("student sees only enrolled classes", async () => {
    const { service } = makeService({
      enrollment: [{ classId: "c-enrolled" }],
      classRows: [{ id: "c-enrolled", name: "Math 201" }],
    });
    const classes = (await service.listMyClasses(principal(["student"]))) as { id: string }[];
    expect(classes.map((c) => c.id)).toEqual(["c-enrolled"]);
  });

  it("parent sees only their children's classes", async () => {
    const { service } = makeService({
      parentChild: [{ studentId: "child-1" }],
      enrollmentForChildren: [{ classId: "c-child" }],
      classRows: [{ id: "c-child", name: "Science 100" }],
    });
    const classes = (await service.listMyClasses(principal(["parent"]))) as { id: string }[];
    expect(classes.map((c) => c.id)).toEqual(["c-child"]);
  });

  it("school_admin sees all classes in the tenant", async () => {
    const { service, classFindMany } = makeService({
      classRows: [
        { id: "c1", name: "A" },
        { id: "c2", name: "B" },
      ],
    });
    const classes = (await service.listMyClasses(principal(["school_admin"]))) as { id: string }[];
    expect(classes).toHaveLength(2);
    // school-wide path queries class.findMany WITHOUT an id filter
    expect(classFindMany).toHaveBeenCalledWith({ orderBy: { name: "asc" } });
  });

  it("a non-member sees no classes", async () => {
    const { service } = makeService({ classRows: [{ id: "c1", name: "A" }] });
    const classes = (await service.listMyClasses(principal(["teacher"]))) as unknown[];
    expect(classes).toEqual([]);
  });

  // Regression for the dead grant: junior_admin holds class.read/class.write and
  // enrollment.read/write, has NO teaching or parental relationship to fall back
  // on, and so saw an empty /classes — the records tier could not open the
  // records. Only the school-wide short-circuit can satisfy this.
  it("junior_admin (records tier) sees every class — matches its class.write grant", async () => {
    const { service, classFindMany } = makeService({
      classRows: [
        { id: "c1", name: "A" },
        { id: "c2", name: "B" },
      ],
    });
    const classes = (await service.listMyClasses(principal(["junior_admin"]))) as { id: string }[];
    expect(classes).toHaveLength(2);
    expect(classFindMany).toHaveBeenCalledWith({ orderBy: { name: "asc" } });
  });

  // board (read-only oversight) and head_teacher (head of teaching) both held
  // class.read and were served nothing. What separates them is the CONTROLLER's
  // permission on each route, not this set: the roster of pupil names needs
  // enrollment.read, which head_teacher holds and board does not.
  it.each(["board", "head_teacher"])("%s sees every class — its class.read grant is real", async (role) => {
    const { service, classFindMany } = makeService({
      classRows: [
        { id: "c1", name: "A" },
        { id: "c2", name: "B" },
      ],
    });
    const classes = (await service.listMyClasses(principal([role]))) as { id: string }[];
    expect(classes).toHaveLength(2);
    expect(classFindMany).toHaveBeenCalledWith({ orderBy: { name: "asc" } });
  });

  it("junior_admin may read any class roster (no teaching relationship needed)", async () => {
    const { service, tx } = makeService({});
    (tx.class.findFirst as jest.Mock).mockResolvedValue({ id: "c1", name: "A" });
    (tx.classTeacher.findFirst as jest.Mock).mockResolvedValue(null);
    (tx.classTeacher.findMany as jest.Mock).mockResolvedValue([]);
    (tx.enrollment.findMany as jest.Mock).mockResolvedValue([]);
    await expect(service.getClassRoster(principal(["junior_admin"]), "c1")).resolves.toEqual(
      expect.objectContaining({ class: { id: "c1", name: "A" } }),
    );
  });

  it("roster access for a non-member of the class is 404", async () => {
    const { service, tx } = makeService({});
    (tx.class.findFirst as jest.Mock).mockResolvedValue({ id: "c1", name: "A" });
    (tx.classTeacher.findFirst as jest.Mock).mockResolvedValue(null); // not a teacher of it
    await expect(service.getClassRoster(principal(["teacher"]), "c1")).rejects.toThrow(/not found/i);
  });
});

// ===========================================================================
// The roster: a COUNT, and a list that is finally bounded
// ===========================================================================
// listStudents was deliberately uncapped because the admin dashboard derived its
// student tile from `.length` of it — so the whole roster was shipped to five
// pages to render one number and four pickers. These pin the replacement: the
// count is a COUNT, and the list is bounded whether or not it is searched.
describe("LmsService roster", () => {
  const mk = (tx: Record<string, unknown>) => {
    const db = {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
    };
    return new LmsService(db as never, { record: jest.fn() } as never);
  };

  it("counts whole-school students in SQL, loading no rows", async () => {
    const count = jest.fn().mockResolvedValue(912);
    const findMany = jest.fn();
    const out = await mk({ user: { count, findMany } }).countStudents(principal(["school_admin"]));
    expect(out).toEqual({ students: 912 });
    expect(findMany).not.toHaveBeenCalled();
    // By ROLE, not by enrolment — a student not yet placed in a class still counts,
    // and this matches the billing seat definition.
    expect(JSON.stringify(count.mock.calls[0][0])).toContain("student");
  });

  it("BOUNDS the unsearched roster — the cap the count made safe to add", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    await mk({ user: { findMany, count: jest.fn() } }).listStudents(principal(["school_admin"]));
    const arg = findMany.mock.calls[0][0] as { take?: number };
    expect(typeof arg.take).toBe("number");
    expect(arg.take).toBeGreaterThan(0);
  });

  it("a search narrows to the tighter SEARCH_CAP, not the roster cap", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    await mk({ user: { findMany, count: jest.fn() } }).listStudents(principal(["school_admin"]), "ada");
    const arg = findMany.mock.calls[0][0] as { take: number; where: { name?: { contains: string } } };
    expect(arg.where.name?.contains).toBe("ada");
    expect(arg.take).toBe(SEARCH_CAP);
  });

  it("junior_admin takes the whole-school roster path, not the relationship one", async () => {
    // The pickers on /admin/parents, /fees, /attendance and /tasks are all fed by
    // listStudents. Falling to the relationship path returned zero rows, so the
    // tier that imports pupils and links guardians had nobody to link.
    const tx = {
  // Capacity checks lock the contended row first (the class / route / slot),
  // so the count and the insert are atomic — the same guard hostel allocation
  // uses for a bed. The mock just has to answer.
  $executeRaw: jest.fn().mockResolvedValue(1),

      user: { count: jest.fn().mockResolvedValue(901), findMany: jest.fn().mockResolvedValue([{ id: "s1" }]) },
      classTeacher: { findMany: jest.fn() },
      enrollment: { findMany: jest.fn() },
      parentChild: { findMany: jest.fn() },
    };
    const rows = (await mk(tx).listStudents(principal(["junior_admin"]))) as unknown[];
    expect(rows).toHaveLength(1);
    // No membership joins on the whole-school path.
    expect(tx.classTeacher.findMany).not.toHaveBeenCalled();
    expect(tx.parentChild.findMany).not.toHaveBeenCalled();
    await expect(mk(tx).countStudents(principal(["junior_admin"]))).resolves.toEqual({ students: 901 });
  });

  it("a relationship-scoped caller's count matches what they can actually list", async () => {
    // Derived from listStudents rather than re-implementing the membership rules,
    // so the tile and the page cannot drift apart.
    const tx = {
      user: { count: jest.fn(), findMany: jest.fn().mockResolvedValue([{ id: "s1" }, { id: "s2" }]) },
      // All three teaching links — see common/teaches.ts. Every real TenantTx
      // answers all three; this teacher happens to tutor c1 and take no
      // subjects, which is the shape the old single-table stub described.
      classTeacher: { findMany: jest.fn().mockResolvedValue([{ classId: "c1" }]) },
      class: { findMany: jest.fn().mockResolvedValue([]) },
      classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
      enrollment: { findMany: jest.fn().mockResolvedValue([{ studentId: "s1" }, { studentId: "s2" }]) },
      parentChild: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const out = await mk(tx).countStudents(principal(["teacher"]));
    expect(out.students).toBe(2);
    // The whole-school COUNT path must NOT be used for a scoped caller.
    expect(tx.user.count).not.toHaveBeenCalled();
  });
});
