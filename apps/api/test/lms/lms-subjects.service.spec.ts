// =============================================================================
// LmsService — subjects + supervisor roster access unit tests
// =============================================================================
// Proves the Phase-A additions: a class supervisor (or a subject teacher) gains
// roster READ access without being a class_teacher; a non-member still gets 404;
// and assigning a class-subject upserts one teacher per (class, subject).

import { NotFoundException } from "@nestjs/common";
import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: {
  cls?: Record<string, unknown> | null;
  classTeacher?: Record<string, unknown> | null;
  classSubjectTeacher?: Record<string, unknown> | null;
  subject?: Record<string, unknown> | null;
  user?: Record<string, unknown> | null;
}) {
  const upsert = jest.fn((args: { create?: Record<string, unknown>; update?: Record<string, unknown> }) =>
    Promise.resolve({ id: "cst1", ...(args.create ?? {}), ...(args.update ?? {}) }),
  );
  const tx = {
    class: {
      findFirst: jest.fn().mockResolvedValue(over.cls === undefined ? { id: "c1", supervisorId: null } : over.cls),
    },
    classTeacher: {
      findFirst: jest.fn().mockResolvedValue(over.classTeacher ?? null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    classSubjectTeacher: {
      findFirst: jest.fn().mockResolvedValue(over.classSubjectTeacher ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert,
    },
    subject: { findFirst: jest.fn().mockResolvedValue(over.subject ?? { id: "s1" }) },
    user: { findFirst: jest.fn().mockResolvedValue(over.user ?? { id: "t1" }) },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new LmsService(db as never, audit as never), upsert };
}

const teacher = (userId = "u-1"): Principal => ({ schoolId: "A", userId, roles: ["teacher"], permissions: [] });

describe("LmsService subjects + supervisor", () => {
  it("lets the class supervisor read the roster even if not a class_teacher", async () => {
    const { service } = makeService({ cls: { id: "c1", supervisorId: "u-1" }, classTeacher: null, classSubjectTeacher: null });
    await expect(service.getClassRoster(teacher("u-1"), "c1")).resolves.toMatchObject({ class: { id: "c1" } });
  });

  it("lets a subject teacher of the class read the roster", async () => {
    const { service } = makeService({ cls: { id: "c1", supervisorId: null }, classTeacher: null, classSubjectTeacher: { id: "cst1" } });
    await expect(service.getClassRoster(teacher("u-2"), "c1")).resolves.toMatchObject({ class: { id: "c1" } });
  });

  it("404s for a non-member (not teacher, supervisor, or subject teacher)", async () => {
    const { service } = makeService({ cls: { id: "c1", supervisorId: "someone-else" }, classTeacher: null, classSubjectTeacher: null });
    await expect(service.getClassRoster(teacher("u-9"), "c1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("assignClassSubject upserts one teacher per (class, subject)", async () => {
    const { service, upsert } = makeService({ cls: { id: "c1" }, subject: { id: "s1" }, user: { id: "t1" } });
    await service.assignClassSubject(teacher("admin"), "c1", "s1", "t1");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { classId_subjectId: { classId: "c1", subjectId: "s1" } } }),
    );
  });
});
