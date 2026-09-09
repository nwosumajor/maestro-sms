// =============================================================================
// The studentId on a new document comes from the REQUEST BODY, and nothing
// checked it named a pupil of this school
// =============================================================================
// `createDocument` calls `assertCanAccessStudent`, which answers "may I reach
// this pupil" — and for a school-wide caller returns on its first line without
// touching the database. That is correct for the four READ paths that call it,
// where the row was already fetched under RLS. It is wrong on create, where the
// id has just arrived from outside, and nothing else looked at it: the only
// thing between a body-supplied id and a stored row was the foreign key.
//
// Measured live as a principal, on a 5,000-school fleet:
//
//   REPORT_CARD attached to ANOTHER SCHOOL's pupil  -> 201
//   REPORT_CARD attached to this school's TEACHER   -> 201
//   REPORT_CARD attached to a uuid that is nobody   -> 500 Internal server error
//
// The first is a report card in this vault about a child who is not this
// school's, which nobody who ought to see it can reach. The second is the
// documented "check the KIND, not merely that it exists". The third is the
// foreign key doing the validating and surfacing as a fault of ours.
//
// EVER_ENROLLED, not on-roll: a school still owes a leaver their records, so a
// document must stay attachable to a pupil who has gone.
// =============================================================================

import { DocumentsService } from "../../src/documents/documents.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const principal: Principal = {
  schoolId: "A",
  userId: "head",
  roles: ["principal"],
  permissions: ["document.write"],
};

/**
 * The `user` double answers the way RLS does: it only ever knows about THIS
 * school's people, and it honours the student-role filter the query carries.
 * A double that returned a row for any id would pass against a service that had
 * stopped filtering — which is the defect.
 */
function makeService(people: Array<{ id: string; roles: string[]; status?: string }>) {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    document: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { ...data, storageKey: "k", contentType: "application/pdf" };
      }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    user: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const found = people.find((u) => u.id === where.id);
        if (!found) return null;
        // `EVER_ENROLLED_STUDENT` narrows on the student role; the double reads
        // the clause rather than ignoring it.
        const needsStudent = JSON.stringify(where.roles ?? {}).includes("student");
        if (needsStudent && !found.roles.includes("student")) return null;
        // ON_ROLL and EVER_ENROLLED differ ONLY by `status: "ACTIVE"`, so a
        // double that ignored `where.status` could not tell them apart — and
        // the leaver case would pass under either. It honours the clause.
        if (where.status !== undefined && (found.status ?? "ACTIVE") !== where.status) return null;
        return { id: found.id, name: "Someone" };
      }),
    },
    parentChild: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    classSubject: { findMany: jest.fn().mockResolvedValue([]) },
    class: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
  };
  const svc = new DocumentsService(
    db as never,
    { record: jest.fn() } as never,
    { presignUpload: jest.fn().mockResolvedValue({ url: "u" }), presignDownload: jest.fn(), download: jest.fn() } as never,
    { notify: jest.fn(), enqueue: jest.fn() } as never,
  );
  return { svc, created, tx };
}

const doc = (studentId: string) => ({
  studentId,
  type: "REPORT_CARD" as const,
  title: "Term 1.pdf",
  contentType: "application/pdf",
});

describe("a document is attached to a pupil of THIS school, or to nobody", () => {
  it("accepts one of the school's own pupils", async () => {
    const { svc, created } = makeService([{ id: "pupil", roles: ["student"] }]);
    await expect(svc.createDocument(principal, doc("pupil"))).resolves.toBeDefined();
    expect(created).toHaveLength(1);
  });

  it("still accepts a LEAVER — a school owes them their records", async () => {
    // EVER_ENROLLED, deliberately: an on-roll filter would make a leaver's
    // transcript unattachable, which is the opposite of what a vault is for.
    const { svc, created } = makeService([{ id: "gone", roles: ["student"], status: "EXITED" }]);
    await expect(svc.createDocument(principal, doc("gone"))).resolves.toBeDefined();
    expect(created).toHaveLength(1);
  });

  it("REFUSES another school's pupil — 404, never confirming they exist", async () => {
    // RLS has already hidden them, so they arrive here as "no such person" and
    // read identically to an id that is nobody.
    const { svc, created } = makeService([{ id: "pupil", roles: ["student"] }]);
    await expect(svc.createDocument(principal, doc("someone-elses-pupil"))).rejects.toThrow(
      /student not found in this school/i,
    );
    expect(created).toHaveLength(0);
  });

  it("REFUSES a member of staff — the KIND is checked, not merely that the id exists", async () => {
    const { svc, created } = makeService([
      { id: "pupil", roles: ["student"] },
      { id: "teach", roles: ["teacher"] },
    ]);
    await expect(svc.createDocument(principal, doc("teach"))).rejects.toThrow(/student not found in this school/i);
    expect(created).toHaveLength(0);
  });

  it("REFUSES a uuid that is nobody — 404, where the foreign key used to answer 500", async () => {
    const { svc, created } = makeService([{ id: "pupil", roles: ["student"] }]);
    await expect(svc.createDocument(principal, doc("00000000-0000-4000-8000-000000000000"))).rejects.toThrow(
      /student not found in this school/i,
    );
    // The point of checking BEFORE the write: the row never reaches the database,
    // so the foreign key is not what decides.
    expect(created).toHaveLength(0);
  });

  it("refuses a constrained caller IDENTICALLY, whether the pupil is real or not", async () => {
    // A teacher asking about a real pupil they do not teach, and a teacher
    // asking about an id that is nobody, must be told the same thing — or the
    // difference between the two answers "is this uuid a real pupil here?".
    // Caught by strengthening this very test: it first asserted only that both
    // refusals were strings, which is true of any two refusals and of any two
    // messages, and it passed while the two differed.
    const teacher: Principal = { schoolId: "A", userId: "t1", roles: ["teacher"], permissions: ["document.write"] };
    const { svc } = makeService([{ id: "pupil", roles: ["student"] }]);
    const notMine = await svc.createDocument(teacher, doc("pupil")).catch((e: Error) => e.message);
    const nobody = await svc.createDocument(teacher, doc("ghost")).catch((e: Error) => e.message);
    // BOTH refused, and refused IDENTICALLY. `expect(typeof x).toBe("string")`
    // would pass on any two refusals and on any two messages, which is a test
    // that proves nothing.
    expect(nobody).toMatch(/document not found/i);
    expect(notMine).toBe(nobody);
  });
});

// =============================================================================
// The READ sibling: a checklist about somebody this school does not have
// =============================================================================
// `GET /documents/checklist?subjectKind=&subjectId=` took the id straight from
// the query string. Measured live, as a principal: another school's pupil, this
// school's own teacher and a uuid that is nobody each returned **200 — missing
// all 5 documents, 0% complete**.
//
// Nothing leaked: the submissions read is RLS-scoped and finds none. What is
// wrong is that a confident answer was given about a person the school does not
// have, which sends a registrar chasing a family that is not theirs.
// =============================================================================

import { SuppliedDocumentsService } from "../../src/documents/supplied-documents.service";

describe("a checklist is about somebody this school has", () => {
  const registrar: Principal = {
    schoolId: "A",
    userId: "head",
    roles: ["principal"],
    permissions: ["student.profile.write", "hr.write"],
  };

  function build(people: Record<string, "student" | "staff">) {
    const tx = {
      user: {
        findFirst: async ({ where }: { where: { id: string; roles?: unknown; NOT?: unknown } }) => {
          const kind = people[where.id];
          if (!kind) return null;
          if (JSON.stringify(where.roles ?? {}).includes("student") && kind !== "student") return null;
          if (JSON.stringify(where.NOT ?? {}).includes("student") && kind === "student") return null;
          return { id: where.id };
        },
        findMany: async () => [],
      },
      admissionApplication: { findFirst: async () => null },
      applicant: { findFirst: async () => null },
      documentRequirement: { findMany: async () => [] },
      documentSubmission: { findMany: async () => [] },
    };
    const db = {
      runAsTenant: <T,>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx),
    };
    const svc = new SuppliedDocumentsService(
      db as never,
      { record: jest.fn() } as never,
      { presignUpload: jest.fn(), presignDownload: jest.fn(), download: jest.fn() } as never,
      { todayInTx: async () => new Date("2026-09-09") } as never,
    );
    return svc;
  }

  it("answers for a pupil the school has", async () => {
    const svc = build({ kid: "student" });
    await expect(svc.checklist(registrar, "STUDENT", "kid")).resolves.toMatchObject({ subjectId: "kid" });
  });

  it("REFUSES another school's pupil, and a uuid that is nobody, identically", async () => {
    const svc = build({ kid: "student" });
    const foreign = await svc.checklist(registrar, "STUDENT", "someone-elses").catch((e: Error) => e.message);
    const ghost = await svc.checklist(registrar, "STUDENT", "nobody").catch((e: Error) => e.message);
    expect(ghost).toMatch(/not on this school's register/i);
    expect(foreign).toBe(ghost);
  });

  it("REFUSES a member of staff asked about as a pupil — the KIND is checked", async () => {
    const svc = build({ kid: "student", teach: "staff" });
    await expect(svc.checklist(registrar, "STUDENT", "teach")).rejects.toThrow(/not on this school's register/i);
  });

  it("...and a pupil asked about as staff", async () => {
    const svc = build({ kid: "student", teach: "staff" });
    await expect(svc.checklist(registrar, "STAFF", "kid")).rejects.toThrow(/not on this school's register/i);
    await expect(svc.checklist(registrar, "STAFF", "teach")).resolves.toBeTruthy();
  });
});
