// =============================================================================
// LmsService — bulk assignment unit tests
// =============================================================================
// Managing rosters one row at a time is where accuracy dies at scale, so subjects
// and enrolments can be assigned in bulk. The guarantees that make bulk SAFE are
// what's tested here:
//   - ALL-OR-NOTHING: every id is validated BEFORE anything is written, so a bad
//     id in the middle of a batch cannot leave a half-built roster behind.
//   - ONE capacity check for the whole batch — a per-student check would let a
//     batch straddle the class limit.
//   - RE-RUNNABLE: already-enrolled students are skipped, not errors, and
//     existing offerings upsert (so re-running changes a teacher).

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: {
  subjects?: { id: string }[];
  users?: { id: string }[];
  rooms?: { id: string }[];
  existingEnrollments?: { studentId: string }[];
  cls?: Record<string, unknown> | null;
  enrollmentCount?: number;
} = {}) {
  const upsert = jest.fn().mockResolvedValue({ id: "cst1" });
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const tx = {
    class: { findFirst: jest.fn().mockResolvedValue(over.cls === undefined ? { id: "c1", capacity: null } : over.cls) },
    subject: { findMany: jest.fn().mockResolvedValue(over.subjects ?? []) },
    // enrollStudentsBulk now verifies every id is a pupil on roll in this
    // school before it writes anything (#248), so both reads answer the same.
    user: { findMany: jest.fn().mockResolvedValue(over.users ?? []) },
    room: { findMany: jest.fn().mockResolvedValue(over.rooms ?? []) },
    classSubjectTeacher: { upsert, findMany: jest.fn().mockResolvedValue([]) },
    enrollment: {
      findMany: jest.fn().mockResolvedValue(over.existingEnrollments ?? []),
      count: jest.fn().mockResolvedValue(over.enrollmentCount ?? 0),
      createMany,
    },
  } as unknown as TenantTx;
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new LmsService(db as never, audit as never);
  return { service, upsert, createMany, tx };
}

const staff = (): Principal => ({ schoolId: "A", userId: "adm", roles: ["school_admin"], permissions: [] });

describe("LmsService bulk assignment", () => {
  describe("assignClassSubjectsBulk", () => {
    it("assigns every offering in one go", async () => {
      const { service, upsert } = makeService({
        subjects: [{ id: "s1" }, { id: "s2" }],
        users: [{ id: "t1" }, { id: "t2" }],
      });
      const res = await service.assignClassSubjectsBulk(staff(), "c1", [
        { subjectId: "s1", teacherId: "t1" },
        { subjectId: "s2", teacherId: "t2" },
      ]);
      expect(res).toEqual({ assigned: 2 });
      expect(upsert).toHaveBeenCalledTimes(2);
    });

    it("writes NOTHING when any subject id is unknown (all-or-nothing)", async () => {
      const { service, upsert } = makeService({
        subjects: [{ id: "s1" }], // only one of the two exists
        users: [{ id: "t1" }],
      });
      await expect(
        service.assignClassSubjectsBulk(staff(), "c1", [
          { subjectId: "s1", teacherId: "t1" },
          { subjectId: "s-missing", teacherId: "t1" },
        ]),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(upsert).not.toHaveBeenCalled(); // the valid row was NOT written
    });

    it("rejects the same subject twice in one batch", async () => {
      const { service } = makeService({ subjects: [{ id: "s1" }], users: [{ id: "t1" }] });
      await expect(
        service.assignClassSubjectsBulk(staff(), "c1", [
          { subjectId: "s1", teacherId: "t1" },
          { subjectId: "s1", teacherId: "t1" },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("enrollStudentsBulk", () => {
    it("enrols the batch and reports the count", async () => {
      const { service, createMany } = makeService({ users: [{ id: "u1" }, { id: "u2" }] });
      const res = await service.enrollStudentsBulk(staff(), "c1", ["u1", "u2"]);
      expect(res).toEqual({ enrolled: 2, skipped: 0 });
      expect(createMany).toHaveBeenCalled();
    });

    it("SKIPS students already enrolled instead of failing (re-runnable)", async () => {
      const { service, createMany } = makeService({
        users: [{ id: "u1" }, { id: "u2" }],
        existingEnrollments: [{ studentId: "u1" }],
      });
      const res = await service.enrollStudentsBulk(staff(), "c1", ["u1", "u2"]);
      expect(res).toEqual({ enrolled: 1, skipped: 1 });
      expect(createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: [expect.objectContaining({ studentId: "u2" })] }),
      );
    });

    it("writes NOTHING when a student id is unknown", async () => {
      const { service, createMany } = makeService({ users: [{ id: "u1" }] });
      await expect(service.enrollStudentsBulk(staff(), "c1", ["u1", "u-missing"])).rejects.toBeInstanceOf(NotFoundException);
      expect(createMany).not.toHaveBeenCalled();
    });

    it("checks capacity ONCE for the whole batch, not per student", async () => {
      // capacity 10, already 8 enrolled, batch of 3 -> must be refused as a batch
      const { service, createMany } = makeService({
        cls: { id: "c1", capacity: 10 },
        users: [{ id: "u1" }, { id: "u2" }, { id: "u3" }],
        enrollmentCount: 8,
      });
      await expect(service.enrollStudentsBulk(staff(), "c1", ["u1", "u2", "u3"])).rejects.toBeTruthy();
      expect(createMany).not.toHaveBeenCalled();
    });

    it("de-duplicates ids in the request", async () => {
      const { service } = makeService({ users: [{ id: "u1" }] });
      const res = await service.enrollStudentsBulk(staff(), "c1", ["u1", "u1", "u1"]);
      expect(res).toEqual({ enrolled: 1, skipped: 0 });
    });
  });
});
