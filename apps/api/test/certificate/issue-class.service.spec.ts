// =============================================================================
// CertificateService.issueForClass — class-wide issuance
// =============================================================================
// Issuing was one pupil at a time, so a testimonial run for a leaving year group
// meant picking 31 names by hand and remembering which were done. The two
// properties that matter here are that it SKIPS pupils who already hold the
// certificate (a certificate is a document a school stands behind — pressing the
// button twice must not mint a second one) and that the human-facing serial stays
// unique across a bulk insert.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CertificateService } from "../../src/certificate/certificate.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = {
  schoolId: "A",
  userId: "issuer",
  roles: ["school_admin"],
  permissions: ["certificate.issue"],
};

const mk = (tx: Record<string, unknown>) => {
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
  };
  return new CertificateService(db as never, { record: jest.fn() } as never, { getLogoBytes: jest.fn() } as never);
};

const base = (over: Record<string, unknown> = {}) => ({
  classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
  class: { findFirst: jest.fn().mockResolvedValue({ id: "c1", name: "JSS2B" }) },
  enrollment: { findMany: jest.fn().mockResolvedValue([{ studentId: "s1" }, { studentId: "s2" }, { studentId: "s3" }]) },
  user: {
    findMany: jest.fn().mockResolvedValue([
      { id: "s1", name: "Adaeze" },
      { id: "s2", name: "Bello" },
      { id: "s3", name: "Chidi" },
    ]),
  },
  issuedCertificate: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn().mockResolvedValue({ count: 3 }) },
  ...over,
});

describe("CertificateService.issueForClass", () => {
  it("issues to the whole class in ONE insert", async () => {
    const tx = base();
    const out = await mk(tx).issueForClass(staff, { classId: "c1", type: "COMPLETION" });
    expect(out).toMatchObject({ issued: 3, skipped: 0 });
    expect(out.students.map((s) => s.name)).toEqual(["Adaeze", "Bello", "Chidi"]);
    // Bulk, not a round trip per pupil.
    expect((tx.issuedCertificate.createMany as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it("SKIPS pupils who already hold that certificate type", async () => {
    const tx = base({
      issuedCertificate: {
        findMany: jest.fn().mockResolvedValue([{ subjectId: "s2" }]),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    });
    const out = await mk(tx).issueForClass(staff, { classId: "c1", type: "COMPLETION" });
    expect(out).toMatchObject({ issued: 2, skipped: 1 });
    // The already-issued pupil is reported, not hidden — the console shows who is done.
    expect(out.students.find((s) => s.id === "s2")?.alreadyIssued).toBe(true);
    const inserted = ((tx.issuedCertificate.createMany as jest.Mock).mock.calls[0][0] as { data: Array<{ subjectId: string }> }).data;
    expect(inserted.map((d) => d.subjectId).sort()).toEqual(["s1", "s3"]);
  });

  it("is idempotent: a second press issues nothing", async () => {
    const tx = base({
      issuedCertificate: {
        findMany: jest.fn().mockResolvedValue([{ subjectId: "s1" }, { subjectId: "s2" }, { subjectId: "s3" }]),
        createMany: jest.fn(),
      },
    });
    const out = await mk(tx).issueForClass(staff, { classId: "c1", type: "COMPLETION" });
    expect(out).toMatchObject({ issued: 0, skipped: 3 });
    expect(tx.issuedCertificate.createMany).not.toHaveBeenCalled();
  });

  it("mints a DISTINCT serial per pupil", async () => {
    // Date.now() is identical across a bulk insert and the column has no unique
    // constraint — a collision would not error, it would silently produce two
    // certificates that verify as the same one.
    const tx = base();
    await mk(tx).issueForClass(staff, { classId: "c1", type: "COMPLETION" });
    const data = ((tx.issuedCertificate.createMany as jest.Mock).mock.calls[0][0] as { data: Array<{ serial: string }> }).data;
    const serials = data.map((d) => d.serial);
    expect(new Set(serials).size).toBe(serials.length);
  });

  it("refuses an unknown type and an empty class", async () => {
    await expect(mk(base()).issueForClass(staff, { classId: "c1", type: "NOT_A_TYPE" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const empty = base({ enrollment: { findMany: jest.fn().mockResolvedValue([]) } });
    await expect(mk(empty).issueForClass(staff, { classId: "c1", type: "COMPLETION" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const noClass = base({ class: { findFirst: jest.fn().mockResolvedValue(null) } });
    await expect(mk(noClass).issueForClass(staff, { classId: "nope", type: "COMPLETION" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
