/**
 * Seeing a document and destroying it are different questions.
 *
 * `deleteDocument` HARD deletes the row and the object bytes, and its only
 * authorisation was `assertCanAccessStudent` — a READ predicate whose own
 * comments talk about never revealing another pupil's document and about a
 * teacher keeping "access to their records". It returns for the PUPIL, for
 * their PARENT, and for any teacher of a class they are in.
 *
 * The two branches were the wrong way round: a school-level document demanded
 * school-wide staff, while a child's REPORT CARD needed only family scope — the
 * stricter guard on the less sensitive object.
 *
 * Measured live: a teacher READ (200) and DELETED (200) a report card the office
 * had generated for a pupil they teach. The vault exists precisely so the family
 * has "an independently retrievable copy ... no matter who generated it", and
 * the NDPR erasure path deliberately RETAINS these as the school's own record
 * and counts them — a plain delete walked past all of it.
 *
 * Live after: read 200, delete 403, the teacher's OWN upload still 200, and a
 * school-wide principal unaffected.
 */
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { DocumentsService } from "../../src/documents/documents.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const OFFICE_DOC = {
  id: "d1", schoolId: "S", studentId: "stu-1", type: "REPORT_CARD",
  title: "Third Term report card", storageKey: "schools/S/documents/d1/report",
  contentType: "application/pdf", status: "UPLOADED", sizeBytes: 10,
  uploadedById: "u-office",
};

const teacher: Principal = {
  schoolId: "S", userId: "u-teacher", roles: ["teacher"],
  permissions: ["document.write", "document.read"],
};
const parent: Principal = {
  schoolId: "S", userId: "u-parent", roles: ["parent"],
  // A family does not hold document.write today. The point of the check is that
  // the permission gate is no longer the ONLY thing standing between them and
  // the school's copy of their child's record — Golden Rule #2.
  permissions: ["document.write", "document.read"],
};
const principal: Principal = {
  schoolId: "S", userId: "u-head", roles: ["principal"],
  permissions: ["document.write", "document.read"],
};

function makeService(doc: Record<string, unknown> = OFFICE_DOC) {
  const del = jest.fn(async () => doc);
  const tx = {
    document: { findFirst: jest.fn(async () => doc), delete: del },
    // The teacher teaches a class the pupil is actively enrolled in, and the
    // parent is linked — so BOTH pass the read predicate. That is the premise:
    // this test is about what happens once you can see it.
    parentChild: { findFirst: jest.fn(async () => ({ id: "link" })), findMany: jest.fn(async () => []) },
    classTeacher: { findMany: jest.fn(async () => [{ classId: "c1" }]) },
    enrollment: { findFirst: jest.fn(async () => ({ id: "e1" })), findMany: jest.fn(async () => []) },
    user: { findFirst: jest.fn(async () => ({ name: "A Pupil" })), findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = new DocumentsService(
    db as never,
    { record: jest.fn(async () => undefined) } as never,
    { delete: jest.fn(async () => undefined), exists: jest.fn(async () => true) } as never,
    { enqueue: jest.fn(async () => undefined), enqueueMany: jest.fn(async () => ({ created: 0, failed: 0 })) } as never,
  );
  return { svc, del };
}

describe("seeing a record is not destroying it", () => {
  it("refuses a teacher deleting a report card the office generated", async () => {
    const { svc, del } = makeService();
    await expect(svc.deleteDocument(teacher, "d1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(del).not.toHaveBeenCalled();
  });

  it("refuses a guardian deleting the school's copy of their child's record", async () => {
    const { svc, del } = makeService();
    await expect(svc.deleteDocument(parent, "d1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(del).not.toHaveBeenCalled();
  });

  it("still lets a teacher remove a document they uploaded themselves", async () => {
    // Not a blanket refusal: `generate` files a NEW document every time, so
    // duplicates accumulate and somebody has to tidy them. You may remove what
    // you put there.
    const { svc, del } = makeService({ ...OFFICE_DOC, uploadedById: "u-teacher" });
    await svc.deleteDocument(teacher, "d1");
    expect(del).toHaveBeenCalled();
  });

  it("leaves school-wide staff able to remove anything", async () => {
    const { svc, del } = makeService();
    await svc.deleteDocument(principal, "d1");
    expect(del).toHaveBeenCalled();
  });

  it("says who CAN do it rather than only refusing", async () => {
    const { svc } = makeService();
    await expect(svc.deleteDocument(teacher, "d1")).rejects.toThrow(/school office|school-wide/i);
  });

  it("refuses with 403, not 404, for somebody who can already see it", async () => {
    // A 404 here would be a positive statement that is untrue: they have just
    // been allowed to read this very document.
    const { svc } = makeService();
    await expect(svc.deleteDocument(teacher, "d1")).rejects.not.toBeInstanceOf(NotFoundException);
  });

  it("still 404s a document the caller cannot see at all", async () => {
    // The visibility check must survive the new one. A stranger to this pupil
    // must not learn the document exists.
    const stranger: Principal = { schoolId: "S", userId: "u-other", roles: ["teacher"], permissions: ["document.write"] };
    const del = jest.fn();
    const tx = {
      document: { findFirst: jest.fn(async () => OFFICE_DOC), delete: del },
      parentChild: { findFirst: jest.fn(async () => null) },
      classTeacher: { findMany: jest.fn(async () => []) },
      enrollment: { findFirst: jest.fn(async () => null) },
    } as unknown as TenantTx;
    const svc = new DocumentsService(
      { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) } as never,
      { record: jest.fn(async () => undefined) } as never,
      { delete: jest.fn(async () => undefined) } as never,
      { enqueue: jest.fn(async () => undefined) } as never,
    );
    await expect(svc.deleteDocument(stranger, "d1")).rejects.toBeInstanceOf(NotFoundException);
    expect(del).not.toHaveBeenCalled();
  });
});
