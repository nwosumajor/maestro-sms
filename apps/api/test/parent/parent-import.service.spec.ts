// =============================================================================
// ParentImportService — single onboarding + bulk maker-checker + child linking
// =============================================================================

import { ParentImportService } from "../../src/parent/parent-import.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

// Bcrypt at cost factor 10 dominates this suite's runtime — that is the security
// parameter doing its job, not slow code, so the timeout moves rather than the
// cost. At the 5s default these pass alone and fail under full-suite
// parallelism, which teaches people to re-run a red suite instead of reading it.
jest.setTimeout(60_000);


function makeService(over: {
  batch?: Record<string, unknown> | null;
  existingParent?: { id: string; name: string; email?: string } | null;
  profiles?: { studentId: string; admissionNumber: string }[];
  studentsByEmail?: { id: string; email: string; contactEmail?: string | null }[];
  onUserCreate?: (data: Record<string, unknown>) => void;
  studentsById?: { id: string }[];
  existingLinks?: { parentId: string; studentId: string }[];
  /** Ids that exist in the school but do NOT hold the student role — a member
   *  of staff, another guardian. Everything else the fixture describes is a
   *  pupil, which is what these fixtures are about. */
  nonPupilIds?: string[];
  updateManyCount?: number;
}) {
  const userCreate = jest.fn(({ data }: { data: { email: string; name: string } }) => {
    over.onUserCreate?.(data as unknown as Record<string, unknown>);
    return Promise.resolve({ id: `new-${data.email}`, name: data.name, email: data.email });
  });
  const userRoleCreate = jest.fn().mockResolvedValue({});
  const parentChildCreate = jest.fn().mockResolvedValue({});
  const batchCreate = jest.fn(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "batch1", createdAt: new Date(), reviewNote: null, reviewedById: null, summary: null, ...data }),
  );
  const batchUpdate = jest.fn(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "batch1", createdAt: new Date(), rows: [], reviewNote: null, uploadedById: "uploader", status: "PENDING", ...data }),
  );
  const batchUpdateMany = jest.fn().mockResolvedValue({ count: over.updateManyCount ?? 1 });
  const links = [...(over.existingLinks ?? [])];
  const tx = {
    role: { findFirst: jest.fn().mockResolvedValue({ id: "parent-role" }) },
    // A new guardian now gets a GENERATED, school-scoped login identifier, so the
    // service resolves the school's slug for the subdomain.
    school: { findFirst: jest.fn().mockResolvedValue({ slug: "demo" }) },
    user: {
      // TWO different lookups now hit this mock, and they must not be conflated:
      //   * the GUARDIAN match, `{ OR: [{contactEmail}, {email}] }` -> may find one
      //   * the login-identifier availability probe, `{ email: candidate }`
      //     -> must report FREE, or the allocator exhausts every candidate.
      findFirst: jest.fn().mockImplementation(
        ({ where }: { where: { id?: string; email?: string; OR?: Array<Record<string, string>> } }) => {
          // A THIRD lookup: `link()` reads a name only to word a refusal.
          if (where.id) return Promise.resolve({ name: `user ${where.id}` });
          return Promise.resolve(where.OR ? (over.existingParent ?? null) : null);
        },
      ),
      findMany: jest.fn().mockImplementation(
        ({ where }: { where: { id?: { in: string[] }; email?: { in: string[] }; OR?: unknown[] } }) => {
          // Child-by-email resolution uses OR:[{email},{contactEmail}]; student
          // validation uses id:{in}.
          if (where.OR || where.email) return Promise.resolve(over.studentsByEmail ?? []);
          return Promise.resolve(over.studentsById ?? []);
        },
      ),
      create: userCreate,
    },
    userRole: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: userRoleCreate,
      // `parent_child` is the family-scope access table, so both write paths now
      // ask whether the target actually holds the STUDENT role. A real TenantTx
      // always has this.
      findMany: jest.fn().mockImplementation(({ where }: { where: { userId: { in: string[] } } }) =>
        Promise.resolve(
          (where.userId?.in ?? [])
            .filter((id: string) => !(over.nonPupilIds ?? []).includes(id))
            .map((userId: string) => ({ userId })),
        ),
      ),
    },
    studentProfile: { findMany: jest.fn().mockResolvedValue(over.profiles ?? []) },
    parentChild: {
      // `link()` reads the pupil's WHOLE guardian list now: it needs the count
      // for MAX_GUARDIANS_PER_STUDENT as well as the duplicate check.
      findMany: jest.fn().mockImplementation(({ where }: { where: { studentId: string } }) =>
        Promise.resolve(links.filter((l) => l.studentId === where.studentId)),
      ),
      create: jest.fn().mockImplementation(({ data }: { data: { parentId: string; studentId: string } }) => {
        links.push({ parentId: data.parentId, studentId: data.studentId });
        return parentChildCreate({ data });
      }),
    },
    parentImportBatch: {
      findFirst: jest.fn().mockResolvedValue(over.batch ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      create: batchCreate,
      update: batchUpdate,
      updateMany: batchUpdateMany,
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new ParentImportService(db as never, audit as never), tx, userCreate, parentChildCreate, batchUpdateMany, batchUpdate, audit };
}

const p = (userId = "staff-1"): Principal => ({ schoolId: "A", userId, roles: ["school_admin"], permissions: ["parent.import"] });

describe("ParentImportService — single onboarding", () => {
  it("creates a NEW parent with a one-time password and links given students", async () => {
    const { service, userCreate, parentChildCreate } = makeService({
      existingParent: null,
      studentsById: [{ id: "stu1" }, { id: "stu2" }],
    });
    const res = await service.createSingle(p(), {
      name: "Grace", email: "grace@x.com", studentIds: ["stu1", "stu2"], relationship: "Mother",
    });
    expect(res.created).toBe(true);
    expect(res.tempPassword).toBeTruthy();
    // Returns the GENERATED sign-in id (grace -> grace@demo.com), not the contact
    // email the guardian was matched on — the slip must show what they log in with.
    expect(res.email).toBe("grace@demo.com");
    expect(res.linkedStudentIds).toEqual(["stu1", "stu2"]);
    expect(userCreate).toHaveBeenCalled();
    expect(parentChildCreate).toHaveBeenCalledTimes(2);
  });

  it("reuses an EXISTING email (no new credential) and still links", async () => {
    const { service, userCreate } = makeService({
      existingParent: { id: "p-existing", name: "Grace", email: "grace@demo.com" },
      studentsById: [{ id: "stu1" }],
    });
    const res = await service.createSingle(p(), { name: "Grace", email: "grace@x.com", studentIds: ["stu1"] });
    expect(res.created).toBe(false);
    expect(res.tempPassword).toBeNull();
    expect(res.parentId).toBe("p-existing");
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("rejects when a referenced student is not in the school", async () => {
    const { service } = makeService({
      existingParent: null,
      studentsById: [{ id: "stu1" }], // only one of the two requested resolves
    });
    await expect(
      service.createSingle(p(), { name: "Grace", email: "grace@x.com", studentIds: ["stu1", "ghost"] }),
    ).rejects.toThrow(/not found in this school/i);
  });
});

describe("ParentImportService — bulk maker-checker", () => {
  it("approval is blocked when the approver uploaded the batch (SoD)", async () => {
    const { service } = makeService({
      batch: { id: "batch1", status: "PENDING", uploadedById: "same", rows: [] },
    });
    await expect(service.approve(p("same"), "batch1")).rejects.toThrow(/different person/i);
  });

  it("approve creates accounts, links children by admission number, returns credentials once", async () => {
    const rows = [
      { name: "Grace", contactEmail: "grace@x.com", studentAdmissionNumbers: "ADM-001;ADM-014", studentEmails: null, relationship: "Mother" },
    ];
    const { service } = makeService({
      batch: { id: "batch1", status: "PENDING", uploadedById: "uploader", rows },
      existingParent: null,
      profiles: [
        { studentId: "stu1", admissionNumber: "ADM-001" },
        { studentId: "stu2", admissionNumber: "ADM-014" },
      ],
    });
    const res = await service.approve(p("approver"), "batch1");
    expect(res.summary?.created).toBe(1);
    expect(res.summary?.linked).toBe(2);
    expect(res.summary?.unmatchedStudents).toBe(0);
    expect(res.credentials).toHaveLength(1);
    // The login slip carries the GENERATED sign-in ID (grace -> grace@demo.com),
    // NOT the guardian\'s real address — that is stored as contactEmail. This is
    // what lets a parent with children at two schools be imported at both.
    expect(res.credentials?.[0].email).toBe("grace@demo.com");
  });

  it("links a child referenced by studentEmails — matched on the student's CONTACT email, not just the generated login", async () => {
    const { service, parentChildCreate } = makeService({
      batch: {
        id: "batch1",
        status: "PENDING",
        uploadedById: "uploader",
        // The school types the child's real (contact) address, not the generated login.
        rows: [{ name: "Grace", contactEmail: "grace@x.com", studentAdmissionNumbers: null, studentEmails: "kid@home.test", relationship: null }],
      },
      existingParent: null,
      // The student's login is generated (kid.one@demo.com); their contact is kid@home.test.
      studentsByEmail: [{ id: "stu-kid", email: "kid.one@demo.com", contactEmail: "kid@home.test" }],
    });
    const res = await service.approve(p("approver"), "batch1");
    expect(res.summary?.linked).toBe(1);
    expect(parentChildCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ studentId: "stu-kid" }) });
  });

  it("AUTO-SUFFIXES two unrelated families sharing a name — both import, distinct logins", async () => {
    const emails: string[] = [];
    const { service } = makeService({
      batch: {
        id: "batch1",
        status: "PENDING",
        uploadedById: "uploader",
        rows: [
          { name: "Blessing Okafor", contactEmail: "one@x.com", studentAdmissionNumbers: null, studentEmails: null, relationship: null },
          { name: "Blessing Okafor", contactEmail: "two@x.com", studentAdmissionNumbers: null, studentEmails: null, relationship: null },
        ],
      },
      existingParent: null,
      onUserCreate: (d) => emails.push(d.email as string),
    });
    const res = await service.approve(p("approver"), "batch1");
    expect(res.summary?.created).toBe(2);
    expect(res.summary?.errors).toBe(0);
    expect(emails).toEqual(["blessing.okafor@demo.com", "blessing.okafor2@demo.com"]);
  });

  it("stores the real address as contactEmail and GENERATES the login identifier", async () => {
    const created: Record<string, unknown>[] = [];
    const { service } = makeService({
      batch: {
        id: "batch1",
        status: "PENDING",
        uploadedById: "uploader",
        rows: [{ name: "Grace", contactEmail: "grace@x.com", studentAdmissionNumbers: null, studentEmails: null, relationship: null }],
      },
      existingParent: null,
      onUserCreate: (data) => created.push(data),
    });
    await service.approve(p("approver"), "batch1");
    expect(created[0]).toMatchObject({
      email: "grace@demo.com",
      contactEmail: "grace@x.com",
      loginEmailGenerated: true,
    });
  });

  it("counts unmatched child references without failing the row", async () => {
    const rows = [
      { name: "Grace", contactEmail: "grace@x.com", studentAdmissionNumbers: "ADM-001;ADM-999", studentEmails: null, relationship: null },
    ];
    const { service } = makeService({
      batch: { id: "batch1", status: "PENDING", uploadedById: "uploader", rows },
      existingParent: null,
      profiles: [{ studentId: "stu1", admissionNumber: "ADM-001" }], // ADM-999 missing
    });
    const res = await service.approve(p("approver"), "batch1");
    expect(res.summary?.linked).toBe(1);
    expect(res.summary?.unmatchedStudents).toBe(1);
  });

  it("a concurrent approval that already claimed the batch is refused", async () => {
    const { service } = makeService({
      batch: { id: "batch1", status: "PENDING", uploadedById: "uploader", rows: [] },
      updateManyCount: 0,
    });
    await expect(service.approve(p("approver"), "batch1")).rejects.toThrow(/already decided/i);
  });
});

// =============================================================================
// A guardian link to somebody who is not a pupil
// =============================================================================
// `parent_child` IS the family-scope access table. Four things write it; only
// LmsService.linkGuardian checked that the target holds the student role
// ("X is not a student"), and it lives in another module, which is how the
// asymmetry survived. AdmissionsService creates the pupil in the same
// transaction, so it is safe by construction. Both paths HERE checked nothing.
//
// The email branch of `resolveChildren` read `user` and matched ANYBODY in the
// school, while the admission-number branch beside it reads `studentProfile`,
// which by construction only exists for a pupil. So a staff address in the
// `studentEmails` column of a spreadsheet attached a guardian to a teacher.
// Measured live before the fix:
//   {"total":1,"errors":0,"linked":1,"created":1,"unmatchedStudents":0}
// -- reported as a clean import.
//
// `link()`'s own comment reasons about "a column mapped to the wrong field" and
// then bounds only how MANY guardians a pupil may have, not what kind of thing
// is being attached.
// =============================================================================

describe("a guardian link is only ever to a pupil", () => {
  const rows = [{ name: "Grace", contactEmail: "grace@x.com", studentEmails: "someone@school.test" }];

  it("does not attach a guardian to a member of staff", async () => {
    const { service, parentChildCreate, batchUpdate } = makeService({
      batch: { id: "b1", status: "PENDING", uploadedById: "other", rows, reviewedById: null, createdAt: new Date(), summary: null, reviewNote: null },
      studentsByEmail: [{ id: "staff-1", email: "someone@school.test", contactEmail: null }],
      nonPupilIds: ["staff-1"],
    });
    await service.approve(p("reviewer"), "b1");
    expect(parentChildCreate).not.toHaveBeenCalled();
    // REPORTED, not silently dropped: the office asked to attach a guardian to
    // a child and no child of that description was found. A row that reports
    // `unmatchedStudents: 0` while linking nobody is the silent-partial-success
    // shape this codebase keeps finding.
    const summary = batchUpdate.mock.calls.at(-1)?.[0].data.summary as { linked: number; unmatchedStudents: number };
    expect(summary.linked).toBe(0);
    expect(summary.unmatchedStudents).toBe(1);
  });

  it("still attaches one to a real pupil with the same address shape", async () => {
    // The half that must not be traded away: the fix is a filter, not a refusal
    // of the whole branch.
    const { service, parentChildCreate, batchUpdate } = makeService({
      batch: { id: "b1", status: "PENDING", uploadedById: "other", rows, reviewedById: null, createdAt: new Date(), summary: null, reviewNote: null },
      studentsByEmail: [{ id: "pupil-1", email: "someone@school.test", contactEmail: null }],
    });
    await service.approve(p("reviewer"), "b1");
    expect(parentChildCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ studentId: "pupil-1" }) }),
    );
    const summary = batchUpdate.mock.calls.at(-1)?.[0].data.summary as { linked: number; unmatchedStudents: number };
    expect(summary.linked).toBe(1);
    expect(summary.unmatchedStudents).toBe(0);
  });

  it("refuses on the SINGLE path too, where the ids come straight from the body", async () => {
    // That path validated only that each id EXISTS in the tenant ("Every
    // provided student must exist in THIS tenant") -- the recorded
    // relationship-writes-trust-body-ids class.
    const { service, parentChildCreate } = makeService({
      existingParent: null,
      studentsById: [{ id: "staff-1" }],
      nonPupilIds: ["staff-1"],
    });
    await expect(
      service.createSingle(p(), { name: "Grace", email: "grace@x.com", studentIds: ["staff-1"] }),
    ).rejects.toMatchObject({ status: 409 });
    expect(parentChildCreate).not.toHaveBeenCalled();
  });

  it("names who it refused, so the office can find the bad column", async () => {
    const { service } = makeService({
      existingParent: null,
      studentsById: [{ id: "staff-1" }],
      nonPupilIds: ["staff-1"],
    });
    await expect(
      service.createSingle(p(), { name: "Grace", email: "grace@x.com", studentIds: ["staff-1"] }),
    ).rejects.toThrow(/is not a student/);
  });
});
