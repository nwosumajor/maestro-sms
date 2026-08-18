// =============================================================================
// SisService — relationship-scoping + medical-audit unit tests
// =============================================================================
// In-memory fakes (no DB). Proves the RBAC-beyond-role access rules and that
// medical READS are audit-logged (Golden Rule #5).
// =============================================================================

import { SisService } from "../../src/sis/sis.service";
import { Prisma } from "@sms/db";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

interface Fakes {
  parentChild?: { id: string }[]; // parent->student link present?
  classTeacher?: { classId: string }[];
  enrollment?: { id: string } | null; // student enrolled in a taught class?
  profile?: { id: string; admissionNumber?: string | null } | null;
  medical?: { id: string } | null;
  usedProfiles?: { admissionNumber: string | null }[];
  upsert?: jest.Mock;
}

function makeService(f: Fakes) {
  const tx = {
    studentProfile: {
      findFirst: jest.fn().mockResolvedValue(f.profile ?? null),
      findMany: jest.fn().mockResolvedValue(f.usedProfiles ?? []),
      upsert: f.upsert ?? jest.fn().mockResolvedValue({ id: "prof-1" }),
    },
    emergencyContact: { findMany: jest.fn().mockResolvedValue([]) },
    medicalRecord: {
      findFirst: jest.fn().mockResolvedValue(f.medical ?? null),
      upsert: jest.fn().mockResolvedValue({ id: "med-1" }),
    },
    parentChild: { findFirst: jest.fn().mockResolvedValue(f.parentChild?.[0] ?? null) },
    classTeacher: { findMany: jest.fn().mockResolvedValue(f.classTeacher ?? []) },
    enrollment: { findFirst: jest.fn().mockResolvedValue(f.enrollment ?? null) },
    // The registry row, because allocating an admission number now asks which
    // year it is WHERE THE SCHOOL IS. The real transaction always has this; a
    // stub without it was simply an incomplete model of one.
    school: { findFirst: jest.fn().mockResolvedValue({ country: "NG", timezone: "Africa/Lagos" }) },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  // Profile submit/review notifies the pupil, guardians and reviewers.
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new SisService(db as never, audit as never, notifications as never);
  return { service, tx, audit };
}

const principal = (roles: string[], userId = "u-1"): Principal => ({
  schoolId: "school-A",
  userId,
  roles,
  permissions: [],
});

describe("SisService relationship scoping", () => {
  it("school_admin can read any student's profile", async () => {
    const { service } = makeService({ profile: { id: "prof-1" } });
    await expect(service.getProfile(principal(["school_admin"]), "stu-9")).resolves.toEqual({
      id: "prof-1",
    });
  });

  it("a student can read their OWN profile", async () => {
    const { service } = makeService({ profile: { id: "prof-self" } });
    await expect(
      service.getProfile(principal(["student"], "stu-self"), "stu-self"),
    ).resolves.toEqual({ id: "prof-self" });
  });

  it("a parent can read their child's profile", async () => {
    const { service } = makeService({ parentChild: [{ id: "link-1" }], profile: { id: "p" } });
    await expect(service.getProfile(principal(["parent"]), "child-1")).resolves.toEqual({ id: "p" });
  });

  it("a teacher can read a student in a class they teach", async () => {
    const { service } = makeService({
      classTeacher: [{ classId: "c-1" }],
      enrollment: { id: "e-1" },
      profile: { id: "p" },
    });
    await expect(service.getProfile(principal(["teacher"]), "stu-x")).resolves.toEqual({ id: "p" });
  });

  it("a teacher canNOT read a student they don't teach (404)", async () => {
    const { service } = makeService({ classTeacher: [{ classId: "c-1" }], enrollment: null });
    await expect(service.getProfile(principal(["teacher"]), "stranger")).rejects.toThrow(/not found/i);
  });

  it("an unrelated parent gets 404", async () => {
    const { service } = makeService({ parentChild: [] });
    await expect(service.getProfile(principal(["parent"]), "not-my-kid")).rejects.toThrow(/not found/i);
  });

  it("junior_admin (records tier) can read any student's profile — matches its student.profile.write grant", async () => {
    const { service } = makeService({ profile: { id: "prof-1" } });
    // No parent/teacher relationship supplied: only the school-wide short-circuit
    // can let junior_admin through. Regression for the dead-grant conflict where
    // junior_admin held student.profile.* but was 404'd on every student.
    await expect(service.getProfile(principal(["junior_admin"]), "stu-9")).resolves.toEqual({ id: "prof-1" });
  });

  it("junior_admin can add an emergency contact for any student", async () => {
    const tx = {
      studentProfile: { findFirst: jest.fn().mockResolvedValue({ id: "prof-1" }) },
      emergencyContact: { create: jest.fn().mockResolvedValue({ id: "ec-1" }) },
      parentChild: { findFirst: jest.fn().mockResolvedValue(null) },
      classTeacher: { findMany: jest.fn().mockResolvedValue([]) },
      enrollment: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as TenantTx;
    const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new SisService(db as never, { record: jest.fn() } as never, notifications as never);
    await expect(
      service.addContact(principal(["junior_admin"]), "stu-9", { name: "Aunt", relationship: "aunt", phone: "080" }),
    ).resolves.toEqual({ id: "ec-1" });
  });

  it("logs the medical READ with the actor (Golden Rule #5)", async () => {
    const { service, audit } = makeService({ profile: { id: "prof-1" }, medical: { id: "med-1" } });
    await service.getMedical(principal(["school_admin"], "admin-1"), "stu-9");
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sis.medical.read",
        entity: "medical_record",
        actorId: "admin-1",
      }),
      expect.anything(),
    );
  });

  it("medical read denied for an unrelated teacher (404, before any audit)", async () => {
    const { service, audit } = makeService({ classTeacher: [{ classId: "c-1" }], enrollment: null });
    await expect(service.getMedical(principal(["teacher"]), "stranger")).rejects.toThrow(/not found/i);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe("SisService.upsertProfile — admission number is protected", () => {
  const admin = principal(["school_admin"]);

  it("PRESERVES an existing admission number when the field is left blank", async () => {
    const upsert = jest.fn().mockResolvedValue({ id: "prof-1" });
    const { service } = makeService({ profile: { id: "prof-1", admissionNumber: "2026/0007" }, upsert });
    await service.upsertProfile(admin, "stu-1", { admissionNumber: null });
    expect(upsert.mock.calls[0][0].update.admissionNumber).toBe("2026/0007");
  });

  it("SETS an explicit new admission number", async () => {
    const upsert = jest.fn().mockResolvedValue({ id: "prof-1" });
    const { service } = makeService({ profile: { id: "prof-1", admissionNumber: "2026/0007" }, upsert });
    await service.upsertProfile(admin, "stu-1", { admissionNumber: "2026/0099" });
    expect(upsert.mock.calls[0][0].update.admissionNumber).toBe("2026/0099");
  });

  it("GENERATES a number for a profile that has none (legacy / first edit)", async () => {
    const upsert = jest.fn().mockResolvedValue({ id: "prof-new" });
    const { service } = makeService({ profile: null, upsert, usedProfiles: [{ admissionNumber: "2026/0003" }] });
    await service.upsertProfile(admin, "stu-1", { admissionNumber: null });
    expect(upsert.mock.calls[0][0].create.admissionNumber).toBe("2026/0004");
  });

  it("returns a clean 409 when the typed number belongs to another student", async () => {
    const upsert = jest.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
    );
    const { service } = makeService({ profile: { id: "prof-1", admissionNumber: "2026/0007" }, upsert });
    await expect(service.upsertProfile(admin, "stu-1", { admissionNumber: "2026/0001" })).rejects.toMatchObject({
      status: 409,
    });
  });
});
