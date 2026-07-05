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

const principal = (roles: string[]): Principal => ({
  schoolId: "school-A",
  userId: "u-1",
  roles,
  permissions: [],
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

  it("roster access for a non-member of the class is 404", async () => {
    const { service, tx } = makeService({});
    (tx.class.findFirst as jest.Mock).mockResolvedValue({ id: "c1", name: "A" });
    (tx.classTeacher.findFirst as jest.Mock).mockResolvedValue(null); // not a teacher of it
    await expect(service.getClassRoster(principal(["teacher"]), "c1")).rejects.toThrow(/not found/i);
  });
});
