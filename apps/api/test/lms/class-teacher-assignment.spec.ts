// =============================================================================
// Assigning a class teacher — and taking it back
// =============================================================================
// There was no removal route at all. A class-teacher assignment is the widest
// relationship in the product: the roster, the grades, the documents, and the
// right to publish untagged content to every pupil in the class. It could be
// granted and never revoked, so a mis-click or a change of form teacher left
// standing access with no way to withdraw it. Verified live before fixing —
// DELETE returned 404 (no route) and the teacher kept full class-wide access.
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantTx } from "../../src/integrity/integrity.foundation";

const admin = { userId: "a1", schoolId: "s1", roles: ["school_admin"], permissions: [] } as unknown as Principal;

function harness(opts: { classExists?: boolean; assignment?: { id: string } | null; teacherExists?: boolean } = {}) {
  const deleted: string[] = [];
  const upserts: Array<Record<string, unknown>> = [];
  const tx = {
    class: { findFirst: jest.fn().mockResolvedValue(opts.classExists === false ? null : { id: "c1", name: "JSS2" }) },
    user: { findFirst: jest.fn().mockResolvedValue(opts.teacherExists === false ? null : { id: "t1" }) },
    classTeacher: {
      findFirst: jest.fn().mockResolvedValue(opts.assignment === undefined ? { id: "ct1" } : opts.assignment),
      upsert: jest.fn((args: Record<string, unknown>) => {
        upserts.push(args);
        return Promise.resolve({ id: "ct1" });
      }),
      delete: jest.fn((args: { where: { id: string } }) => {
        deleted.push(args.where.id);
        return Promise.resolve({ id: args.where.id });
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new LmsService(db as never, audit as never), tx, deleted, upserts, audit };
}

describe("removing a class teacher", () => {
  it("deletes the assignment and audits it", async () => {
    const { svc, deleted, audit } = harness();
    await expect(svc.removeTeacher(admin, "c1", "t1")).resolves.toMatchObject({ removed: true });
    expect(deleted).toEqual(["ct1"]);
    // record(payload, tx) — assert the payload, not the arity.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "lms.teacher.remove", entityId: "c1", metadata: { teacherId: "t1" } }),
      expect.anything(),
    );
  });

  it("404s when that teacher is not assigned here", async () => {
    const { svc, deleted } = harness({ assignment: null });
    await expect(svc.removeTeacher(admin, "c1", "t1")).rejects.toThrow(NotFoundException);
    expect(deleted).toHaveLength(0);
  });

  it("404s on a class in another school", async () => {
    // RLS already hides it; the service must not turn that into a 500 or leak
    // which of the two things was missing.
    const { svc } = harness({ classExists: false });
    await expect(svc.removeTeacher(admin, "other", "t1")).rejects.toThrow(NotFoundException);
  });

  it("removes the LAST teacher too", async () => {
    // A class with no class teacher is a normal state — it is how every class
    // starts. Refusing here would make a mistake unfixable in exactly the case
    // you most need to fix it.
    const { svc, deleted } = harness();
    await svc.removeTeacher(admin, "c1", "t1");
    expect(deleted).toEqual(["ct1"]);
  });
});

describe("assigning a class teacher", () => {
  it("is idempotent — a double click is not an error", async () => {
    // A plain create hits the (classId, teacherId) unique index and surfaces a
    // raw 500 on the second click.
    const { svc, upserts } = harness();
    await svc.assignTeacher(admin, "c1", "t1");
    await svc.assignTeacher(admin, "c1", "t1");
    expect(upserts).toHaveLength(2);
    expect(upserts[0]).toMatchObject({ where: { classId_teacherId: { classId: "c1", teacherId: "t1" } } });
  });

  it("404s on a teacher who does not exist", async () => {
    // The scalar FK has no Prisma relation, so an unknown id would otherwise
    // land as a foreign-key 500 at commit.
    const { svc } = harness({ teacherExists: false });
    await expect(svc.assignTeacher(admin, "c1", "ghost")).rejects.toThrow(NotFoundException);
  });
});
