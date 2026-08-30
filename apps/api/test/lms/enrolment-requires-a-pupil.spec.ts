// =============================================================================
// Enrolling accepted anything with a uuid
// =============================================================================
// Swept for the shape behind the guardian-link defect (#247) — a relationship
// write that takes ids from the request body and checks neither of them. The
// same service had it on the relationship that matters most.
//
// `enrollStudent` verified the CLASS and took the student id on trust. Against
// the running system:
//
//   201  a TEACHER as a pupil
//   201  a pupil from ANOTHER school
//   201  the platform SYSTEM account
//   201  a real pupil (happy path)
//   500  the SAME pupil again    <- unique violation, straight to the client
//
// An enrolment is not a label. It puts that account on the class register to be
// marked present or absent, on the roster, in the report-card run and in the
// capacity count — and it grants every teacher of the class relationship-scoped
// access to that person's profile, documents and attendance.
//
// NOT a billing problem, checked rather than assumed: `countOnRollStudents`
// bills on the student ROLE and user status, not on enrolments, so a teacher
// enrolled into a class was never charged for.
// =============================================================================

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const admin: Principal = {
  schoolId: "S",
  userId: "u-admin",
  roles: ["school_admin"],
  permissions: ["enrollment.write"],
};

const PUPIL = { id: "s-1", name: "Chidi Obi" };
const PUPIL2 = { id: "s-2", name: "Ada Nwosu" };
const TEACHER = { id: "t-1", name: "Mr Bello" };

function makeService(opts: {
  users?: Array<{ id: string; name: string }>;
  students?: string[];
  existing?: Array<{ id: string; studentId: string; status: string }>;
  capacity?: number | null;
}) {
  const users = opts.users ?? [PUPIL, PUPIL2, TEACHER];
  const students = new Set(opts.students ?? [PUPIL.id, PUPIL2.id]);
  const created: Array<{ studentId: string }> = [];
  const createdMany: Array<{ studentId: string }> = [];
  const tx = {
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    class: { findFirst: jest.fn(async () => ({ id: "c-1", capacity: opts.capacity ?? null })) },
    user: {
      // Two reads: everyone in the school by id, then the ON_ROLL_STUDENT
      // subset. The second carries the shared scope's `roles`/`status` filter,
      // which is how the stub tells them apart.
      findMany: jest.fn(async (a: { where: { id: { in: string[] }; roles?: unknown } }) => {
        const inSchool = users.filter((u) => a.where.id.in.includes(u.id));
        return a.where.roles ? inSchool.filter((u) => students.has(u.id)) : inSchool;
      }),
    },
    enrollment: {
      findFirst: jest.fn(async (a: { where: { studentId: string } }) =>
        (opts.existing ?? []).find((e) => e.studentId === a.where.studentId) ?? null,
      ),
      findMany: jest.fn(async () => opts.existing ?? []),
      count: jest.fn(async () => 0),
      create: jest.fn(async (a: { data: { studentId: string } }) => {
        created.push(a.data);
        return { id: "e-new", ...a.data };
      }),
      createMany: jest.fn(async (a: { data: Array<{ studentId: string }> }) => {
        createdMany.push(...a.data);
        return { count: a.data.length };
      }),
    },
    $executeRaw: jest.fn(async () => 0),
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = new LmsService(db as never, { record: jest.fn() } as never);
  return { svc, created, createdMany };
}

describe("putting a pupil in a class", () => {
  it("works for an actual pupil", async () => {
    const { svc, created } = makeService({});
    await svc.enrollStudent(admin, "c-1", PUPIL.id);
    expect(created).toEqual([{ schoolId: "S", classId: "c-1", studentId: "s-1" }]);
  });

  it("refuses a pupil who has LEFT the school", async () => {
    // The shared ON_ROLL definition, not a bare role check: an exited pupil
    // still holds the student role and must not reappear on a register.
    const { svc, created } = makeService({ students: [PUPIL2.id] });
    await expect(svc.enrollStudent(admin, "c-1", PUPIL.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(created).toEqual([]);
  });

  it("refuses a member of staff", async () => {
    const { svc, created } = makeService({});
    await expect(svc.enrollStudent(admin, "c-1", TEACHER.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(created).toEqual([]);
  });

  it("names who was refused, and why", async () => {
    // "Invalid student" tells an office nothing. It has a list of names.
    const { svc } = makeService({});
    await expect(svc.enrollStudent(admin, "c-1", TEACHER.id)).rejects.toThrow(/Mr Bello/);
    await expect(svc.enrollStudent(admin, "c-1", TEACHER.id)).rejects.toThrow(/on roll/i);
  });

  it("cannot reach a user in another school", async () => {
    // RLS confines the read, so anyone else is NOT FOUND — the id came from a
    // request body.
    const { svc, created } = makeService({});
    await expect(svc.enrollStudent(admin, "c-1", "s-elsewhere")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(created).toEqual([]);
  });

  it("refuses the same pupil twice with a 409, not a 500", async () => {
    const { svc, created } = makeService({
      existing: [{ id: "e-1", studentId: PUPIL.id, status: "ACTIVE" }],
    });
    await expect(svc.enrollStudent(admin, "c-1", PUPIL.id)).rejects.toBeInstanceOf(ConflictException);
    expect(created).toEqual([]);
  });

  it("says to reactivate when the pupil LEFT this class rather than adding a second row", async () => {
    // The unique index is on (classId, studentId) regardless of status, so a
    // returning pupil cannot simply be re-added — and "already in this class"
    // would be a lie about somebody who is not.
    const { svc } = makeService({
      existing: [{ id: "e-1", studentId: PUPIL.id, status: "TRANSFERRED" }],
    });
    await expect(svc.enrollStudent(admin, "c-1", PUPIL.id)).rejects.toThrow(/reactivate/i);
  });

  it("checks who the pupil is BEFORE taking a capacity lock", async () => {
    // Locking the class row for a request that was always going to be refused
    // serialises every other enrolment behind it.
    const { svc } = makeService({ capacity: 30 });
    await expect(svc.enrollStudent(admin, "c-1", TEACHER.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("the bulk path obeys the same rule", () => {
  it("enrols a batch of real pupils", async () => {
    const { svc, createdMany } = makeService({});
    await expect(svc.enrollStudentsBulk(admin, "c-1", [PUPIL.id, PUPIL2.id])).resolves.toEqual({
      enrolled: 2,
      skipped: 0,
    });
    expect(createdMany).toHaveLength(2);
  });

  it("refuses the WHOLE batch if one of them is not a pupil", async () => {
    // Partially enrolling a roster import is worse than refusing it: nobody
    // reconciles what went in against what was sent.
    const { svc, createdMany } = makeService({});
    await expect(
      svc.enrollStudentsBulk(admin, "c-1", [PUPIL.id, TEACHER.id]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createdMany).toEqual([]);
  });

  it("still skips pupils already in the class rather than failing", async () => {
    // Re-running a roster import has to stay safe.
    const { svc } = makeService({
      existing: [{ id: "e-1", studentId: PUPIL.id, status: "ACTIVE" }],
    });
    await expect(svc.enrollStudentsBulk(admin, "c-1", [PUPIL.id])).resolves.toEqual({
      enrolled: 0,
      skipped: 1,
    });
  });
});
