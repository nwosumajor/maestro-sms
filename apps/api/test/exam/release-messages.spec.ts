// =============================================================================
// Two blind refusals at the sharpest moment in the product
// =============================================================================
// Releasing a CBT paper into an exam hall is a single, timed, one-shot action:
// an invigilator presses it with a room full of pupils waiting. Both ways it
// could refuse told them nothing they could act on.
//
//   "The exam can only be released on or after its scheduled date"
//     — without saying WHAT that date is. Early, or the sitting mis-dated? The
//       CBT page cannot answer either: it never shows the sitting a paper is
//       attached to. #190 made this worse than hypothetical — a timezone bug
//       produced exactly this refusal spuriously, and this message gave an
//       invigilator nothing to diagnose it with.
//
//   "The exam is not approved for release, or has already been released"
//     — an OR of two OPPOSITE situations. One means go and get approval; the
//       other means the paper is already open and the hall can start. Told both
//       at once, nobody can tell whether to panic.
//
// The second is also a correctness point, not only wording: ALREADY RELEASED IS
// NOT A FAILURE. The desired state holds. Two invigilators pressing the button,
// or one impatient double-click, must not read as something broken.
// =============================================================================

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { ExamService } from "../../src/exam/exam.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const invigilator: Principal = {
  schoolId: "school-A",
  userId: "head-1",
  roles: ["principal"],
  permissions: ["exam.release"],
};

function makeService(opts: {
  sitting?: { cbtExamId: string | null; date: Date; title: string } | null;
  updateCount?: number;
  exam?: { status: string; releasedAt: Date | null } | null;
  today?: Date;
}) {
  const {
    sitting = { cbtExamId: "cbt-1", date: new Date("2026-10-10T00:00:00.000Z"), title: "Physics Paper 1" },
    updateCount = 1,
    exam = null,
    today = new Date("2026-10-10T00:00:00.000Z"),
  } = opts;
  const tx = {
    examSitting: { findFirst: jest.fn().mockResolvedValue(sitting) },
    cbtExam: {
      updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
      findFirst: jest.fn().mockResolvedValue(exam),
    },
    examSeat: { findMany: jest.fn().mockResolvedValue([]) },
    parentChild: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new ExamService(
    db as never,
    { record: jest.fn() } as never,
    { enqueueMany: jest.fn(), enqueue: jest.fn() } as never,
    { createRequest: jest.fn() } as never,
    { todayInTx: async () => today } as never,
    { onFinalized: jest.fn() } as never,
  );
  return { service, tx };
}

describe("refusing because it is too early", () => {
  it("names the paper AND the date it is scheduled for", async () => {
    const { service } = makeService({
      sitting: { cbtExamId: "cbt-1", date: new Date("2026-10-12T00:00:00.000Z"), title: "Physics Paper 1" },
      today: new Date("2026-10-10T00:00:00.000Z"),
    });
    await expect(service.releaseSitting(invigilator, "sit-1")).rejects.toThrow(
      /"Physics Paper 1" is scheduled for 2026-10-12/,
    );
  });

  it("releases ON the day, not only after it", async () => {
    // The boundary that matters: an invigilator releases on the morning of the
    // exam, not the day after.
    const { service } = makeService({
      sitting: { cbtExamId: "cbt-1", date: new Date("2026-10-10T00:00:00.000Z"), title: "P1" },
      today: new Date("2026-10-10T00:00:00.000Z"),
    });
    await expect(service.releaseSitting(invigilator, "sit-1")).resolves.toMatchObject({ released: true });
  });
});

describe("when the update matched nothing", () => {
  it("ALREADY RELEASED is a success, not an error", async () => {
    // The hall is running. Saying "no" here would send somebody looking for a
    // fault that does not exist.
    const { service } = makeService({
      updateCount: 0,
      exam: { status: "PUBLISHED", releasedAt: new Date("2026-10-10T08:00:00.000Z") },
    });
    await expect(service.releaseSitting(invigilator, "sit-1")).resolves.toMatchObject({
      released: true,
      alreadyReleased: true,
    });
  });

  it("does NOT notify again on a repeat press", async () => {
    // Pupils and guardians were told the first time. Telling them twice because
    // an invigilator clicked twice is its own small harm.
    const { service } = makeService({
      updateCount: 0,
      exam: { status: "PUBLISHED", releasedAt: new Date() },
    });
    const res = await service.releaseSitting(invigilator, "sit-1");
    expect(res.alreadyReleased).toBe(true);
  });

  it("NOT APPROVED says so, and names the state it is in", async () => {
    // The actionable half of the old OR: this one needs somebody to approve the
    // schedule, and now says which state is blocking it.
    const { service } = makeService({
      updateCount: 0,
      exam: { status: "DRAFT", releasedAt: null },
    });
    await expect(service.releaseSitting(invigilator, "sit-1")).rejects.toThrow(
      /is DRAFT, not PUBLISHED — its schedule needs approving/,
    );
  });

  it("a vanished paper says that plainly", async () => {
    const { service } = makeService({ updateCount: 0, exam: null });
    await expect(service.releaseSitting(invigilator, "sit-1")).rejects.toThrow(/no longer exists/);
  });
});

describe("the refusals that were already clear stay clear", () => {
  it("a paper sitting has nothing to release", async () => {
    const { service } = makeService({
      sitting: { cbtExamId: null, date: new Date("2026-10-10T00:00:00.000Z"), title: "Maths (written)" },
    });
    await expect(service.releaseSitting(invigilator, "sit-1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("an unknown sitting is 404, not 403", async () => {
    const { service } = makeService({ sitting: null });
    await expect(service.releaseSitting(invigilator, "sit-1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("every refusal that IS a refusal is still a Conflict", async () => {
    const { service } = makeService({ updateCount: 0, exam: { status: "DRAFT", releasedAt: null } });
    await expect(service.releaseSitting(invigilator, "sit-1")).rejects.toBeInstanceOf(ConflictException);
  });
});
