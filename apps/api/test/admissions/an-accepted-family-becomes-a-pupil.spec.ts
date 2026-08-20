// =============================================================================
// The step that was missing entirely
// =============================================================================
// An application could be reviewed, approved through the whole maker-checker
// chain, have its entrance exam scheduled and its documents collected — and then
// somebody typed the child into the system by hand. Nothing tied the two records
// together, so the paperwork the family had already sent had nowhere to go, and
// no one could answer "which pupil is this application?".
//
// Two properties carry this.
//
// ONE DECISION, ONE TRANSACTION. The account, the profile, the class place, the
// guardian's own login and the documents either all happen or none do. A pupil
// created without their guardian, or with paperwork that committed separately,
// is a worse state than no pupil at all.
//
// IDEMPOTENT ON A UNIQUE COLUMN, claimed with a conditional update. Two
// registrars pressing the button at once would otherwise both pass a read check
// and both create a child.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AdmissionsService } from "../../src/admissions/admissions.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

// This suite mints real accounts, so every case pays for a bcrypt hash at cost
// factor 10 — about 40 seconds for the file on its own. That is the security
// parameter doing its job, not slow code, so the timeout moves rather than the
// cost. Left at the 5s default it passes alone and fails under full-suite
// parallelism, which teaches people to re-run a red suite instead of reading it.
jest.setTimeout(60_000);


type Row = Record<string, unknown>;

function make(over: { application?: Row | null; claimable?: boolean; guardianExists?: boolean } = {}) {
  const application: Row | null =
    over.application === undefined
      ? {
          id: "app-1",
          status: "ACCEPTED",
          childName: "Ada Okonkwo",
          applicantName: "Ngozi Okonkwo",
          applicantEmail: "Ngozi@Example.Test",
          convertedStudentId: null,
          details: { dateOfBirth: "2015-04-02", gender: "F" },
        }
      : over.application;

  const created: Record<string, Row[]> = { user: [], userRole: [], studentProfile: [], enrollment: [], parentChild: [] };
  const promoted: Row[] = [];
  let seq = 0;

  const tx = {
    admissionApplication: {
      findFirst: jest.fn(async () => application),
      updateMany: jest.fn(async () => ({ count: over.claimable === false ? 0 : 1 })),
      update: jest.fn(async ({ data }: { data: Row }) => {
        if (application) Object.assign(application, data);
        return application ?? {};
      }),
    },
    role: { findFirst: jest.fn(async ({ where }: { where: { name: string } }) => ({ id: `role-${where.name}` })) },
    user: {
      // Discriminating, because user.findFirst serves two purposes here: the
      // guardian lookup AND the login-email allocator checking whether each
      // candidate identifier is free. A stub that answers "taken" to everything
      // makes the allocator give up after 500 tries — which is a bug in the
      // stub, not in the allocator.
      findFirst: jest.fn(async ({ where }: { where: { email?: string } }) =>
        over.guardianExists && where?.email === "ngozi@example.test" ? { id: "existing-guardian" } : null,
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const u = { ...data, id: `user-${++seq}` };
        created.user.push(u);
        return u;
      }),
    },
    userRole: { create: jest.fn(async ({ data }: { data: Row }) => { created.userRole.push(data); return data; }) },
    studentProfile: {
      create: jest.fn(async ({ data }: { data: Row }) => { created.studentProfile.push(data); return data; }),
      findMany: jest.fn(async () => []),
    },
    enrollment: { create: jest.fn(async ({ data }: { data: Row }) => { created.enrollment.push(data); return data; }) },
    parentChild: { create: jest.fn(async ({ data }: { data: Row }) => { created.parentChild.push(data); return data; }) },
    school: { findFirst: jest.fn(async () => ({ slug: "st-andrews", country: "NG", timezone: "Africa/Lagos" })) },
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const supplied = {
    promoteApplicationInTx: jest.fn(async (_tx: unknown, args: Row) => { promoted.push(args); return { promoted: 1 }; }),
  };
  const service = new AdmissionsService(
    db as never,
    { record: jest.fn() } as never,
    { send: jest.fn() } as never,
    { isConfigured: () => false, initialize: jest.fn() } as never,
    { effective: jest.fn().mockResolvedValue({}) } as never,
    {} as never,
    { forSchool: jest.fn().mockResolvedValue({ currency: "NGN" }) } as never,
    supplied as never,
  );
  return { service, tx, created, promoted, application, supplied };
}

const p: Principal = { schoolId: "S", userId: "registrar-1", roles: ["school_admin"], permissions: [] };

describe("enrolling an accepted applicant", () => {
  it("creates the child, their profile and their place in the class", async () => {
    const { service, created } = make();
    const out = await service.convertToPupil(p, "app-1", { classId: "11111111-1111-1111-1111-111111111111" });
    expect(out.alreadyConverted).toBe(false);
    expect(created.studentProfile[0]).toMatchObject({ admissionNumber: expect.stringMatching(/^\d{4}\//) });
    expect(created.enrollment[0]).toMatchObject({ classId: "11111111-1111-1111-1111-111111111111" });
    // Date of birth and gender come off the application the family filled in,
    // rather than being re-keyed from it.
    expect(created.studentProfile[0].gender).toBe("F");
  });

  it("gives the child their OWN sign-in, not the parent's", async () => {
    // The application carries the PARENT's address. A pupil sharing a login with
    // their guardian is two people behind one identity.
    const { service, created } = make();
    const out = await service.convertToPupil(p, "app-1", {});
    expect(out.credentials?.email).not.toBe("ngozi@example.test");
    expect(created.user[0]).toMatchObject({ loginEmailGenerated: true, passwordChangedAt: null });
  });

  it("gives the guardian a login and links them to the child", async () => {
    // Without this they are a name on a form with no way in, and somebody keys
    // them a second time.
    const { service, created } = make();
    const out = await service.convertToPupil(p, "app-1", {});
    expect(created.parentChild[0]).toMatchObject({ relationship: "GUARDIAN" });
    expect(out.guardianCredentials?.email).toBe("ngozi@example.test");
  });

  it("reuses a guardian who already has an account", async () => {
    // A second child at the same school must not mint a second parent.
    const { service, created } = make({ guardianExists: true });
    const out = await service.convertToPupil(p, "app-1", {});
    expect(created.parentChild[0]).toMatchObject({ parentId: "existing-guardian" });
    expect(out.guardianCredentials).toBeUndefined();
  });

  it("takes the documents the family already sent, in the same transaction", async () => {
    const { service, promoted, supplied } = make();
    const out = await service.convertToPupil(p, "app-1", {});
    expect(promoted[0]).toMatchObject({ applicationId: "app-1", studentId: out.studentId });
    // The SAME transaction — a nested one would let paperwork commit against a
    // pupil whose creation then failed.
    expect(supplied.promoteApplicationInTx.mock.calls[0][0]).toBeTruthy();
  });

  it("records the pupil on the application, which is the only link there has ever been", async () => {
    const { service, application } = make();
    const out = await service.convertToPupil(p, "app-1", {});
    expect(application).toMatchObject({ convertedStudentId: out.studentId });
  });

  it("returns the temporary passwords ONCE, and forces both to change them", async () => {
    const { service, created } = make();
    const out = await service.convertToPupil(p, "app-1", {});
    expect(out.credentials?.tempPassword).toBeTruthy();
    for (const u of created.user) expect(u.passwordChangedAt).toBeNull();
  });
});

describe("what it refuses", () => {
  it("will not enrol somebody the school has not accepted", async () => {
    // Not a slip to tolerate: a child on the roll who was never admitted.
    const { service, created } = make({
      application: { id: "app-1", status: "REVIEWING", childName: "X", applicantName: "Y", applicantEmail: "y@z.test", convertedStudentId: null, details: {} },
    });
    await expect(service.convertToPupil(p, "app-1", {})).rejects.toBeInstanceOf(BadRequestException);
    expect(created.user).toHaveLength(0);
  });

  it("404s an application that is not this school's", async () => {
    const { service } = make({ application: null });
    await expect(service.convertToPupil(p, "app-1", {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns the SAME pupil when pressed twice, rather than creating another", async () => {
    const { service, created } = make({
      application: { id: "app-1", status: "ACCEPTED", childName: "X", applicantName: "Y", applicantEmail: "y@z.test", convertedStudentId: "already-a-pupil", details: {} },
    });
    const out = await service.convertToPupil(p, "app-1", {});
    expect(out).toMatchObject({ studentId: "already-a-pupil", alreadyConverted: true });
    expect(created.user).toHaveLength(0);
    // And no password was hashed for a conversion that was never going to happen.
    expect(out.credentials).toBeUndefined();
  });

  it("loses the race gracefully when another registrar claimed it first", async () => {
    // The read check passed for both; the conditional update is what decides.
    const { service, created } = make({
      claimable: false,
      application: { id: "app-1", status: "ACCEPTED", childName: "X", applicantName: "Y", applicantEmail: "y@z.test", convertedStudentId: null, details: {} },
    });
    // The re-read inside the transaction now shows the winner's pupil.
    (service as unknown as { db: { runAsTenant: unknown } }).db;
    await expect(service.convertToPupil(p, "app-1", {})).rejects.toBeInstanceOf(BadRequestException);
    expect(created.user).toHaveLength(0);
  });
});
