// =============================================================================
// A hall, a date, a class — and no family ever heard of it
// =============================================================================
// Found by RUNNING a path that had never executed: `exam_sitting`, `exam_seat`
// and `exam_invigilator` all had zero rows, so the exam hall had never once been
// used end to end.
//
// `GET /exams/mine` — what a pupil and a parent read — returns SEATS. So an
// unseated sitting is invisible to everyone it is for. Seating existed ONLY per
// schedule (`POST /exams/schedules/:id/seat`), and the planner's own form offers
// "No schedule" as its FIRST AND DEFAULT option. So the ordinary way to add one
// exam produced a sitting with a hall, a date, a time and a class, which nothing
// in the product could seat and no family could see — while the staff planner
// listed it as complete.
//
// Live before this: a sitting created without a schedule, `POST /exams/:id/seat`
// 404, and `/exams/mine` empty for both the pupil and their parent. After:
// seated 1, and both see "Mathematics Paper 1 seat 1".
//
// The staff badge said "not seated" in a neutral outline, among "no
// invigilator" — a school reads that as tidying-up rather than as "nobody has
// been told". It now says the consequence, and the row carries the one-click fix.
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { ExamService } from "../../src/exam/exam.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const STAFF: Principal = { userId: "u1", schoolId: "school-1", roles: ["principal"], permissions: ["exam.manage"] };

function makeService(sitting: Record<string, unknown> | null, outcome: Record<string, unknown>) {
  const svc = Object.create(ExamService.prototype) as ExamService;
  const tx = { examSitting: { findFirst: jest.fn().mockResolvedValue(sitting) } };
  Object.assign(svc, {
    db: { runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx)) },
    audit: { record: jest.fn() },
    ctx: () => ({ schoolId: STAFF.schoolId, userId: STAFF.userId }),
  });
  const auto = jest.fn().mockResolvedValue(outcome);
  (svc as unknown as { autoSeatSchedule: unknown }).autoSeatSchedule = auto;
  return { svc, auto, tx };
}

const SITTING = { id: "sit-1", title: "Mathematics Paper 1", classId: "class-1", cbtExamId: null };
const none = { alreadySeated: 0, noClass: 0, emptyClass: 0 };

describe("seating one sitting", () => {
  it("seats it from its own class, with no schedule anywhere in sight", async () => {
    const { svc, auto } = makeService(SITTING, { seatedCount: 1, seatedStudents: 24, overflow: [], reasons: none });
    const out = await svc.seatSitting(STAFF, "sit-1");
    expect(out).toEqual({ seated: true, seatedStudents: 24, unseated: 0, reason: null });
    // Addressed by SITTING id, not by schedule — the whole point.
    expect(auto).toHaveBeenCalledWith(expect.anything(), "school-1", { id: "sit-1" });
  });

  it("404s a sitting in another school, never 403", async () => {
    // A sitting in another tenant is not one this caller may learn the
    // existence of.
    const { svc } = makeService(null, {});
    await expect(svc.seatSitting(STAFF, "sit-1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("says WHY nothing happened, in the words of the thing to fix", async () => {
    // "Seated 0" on its own sends an exam officer hunting through a roster.
    const cases: Array<[Record<string, number>, string]> = [
      [{ ...none, alreadySeated: 1 }, "already seated"],
      [{ ...none, noClass: 1 }, "no class attached"],
      [{ ...none, emptyClass: 1 }, "nobody enrolled"],
    ];
    for (const [reasons, expected] of cases) {
      const { svc } = makeService(SITTING, { seatedCount: 0, seatedStudents: 0, overflow: [], reasons });
      const out = await svc.seatSitting(STAFF, "sit-1");
      expect([expected, out.seated]).toEqual([expected, false]);
      expect(out.reason).toContain(expected);
    }
  });

  it("is idempotent — a pupil told seat 14 must not find themselves in seat 31", async () => {
    const { svc } = makeService(SITTING, { seatedCount: 0, seatedStudents: 0, overflow: [], reasons: { ...none, alreadySeated: 1 } });
    const out = await svc.seatSitting(STAFF, "sit-1");
    expect(out.seated).toBe(false);
    expect(out.reason).toContain("already seated");
  });

  it("reports candidates a hall could not fit, rather than seating some in silence", async () => {
    const { svc } = makeService(SITTING, {
      seatedCount: 1,
      seatedStudents: 40,
      overflow: [{ sittingId: "sit-1", capacity: 40, classSize: 52, unseated: 12 }],
      reasons: none,
    });
    const out = await svc.seatSitting(STAFF, "sit-1");
    expect(out).toMatchObject({ seated: true, seatedStudents: 40, unseated: 12 });
  });

  it("audits the act, naming what it did", async () => {
    const { svc } = makeService(SITTING, { seatedCount: 1, seatedStudents: 24, overflow: [], reasons: none });
    await svc.seatSitting(STAFF, "sit-1");
    const audit = (svc as unknown as { audit: { record: jest.Mock } }).audit.record;
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "exam.sitting.seat", entity: "exam_sitting", entityId: "sit-1" }),
      expect.anything(),
    );
  });
});
