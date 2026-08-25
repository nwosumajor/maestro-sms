// =============================================================================
// Told it does not exist, on the screen that is showing it
// =============================================================================
// Found by RUNNING a path that had never executed: `subject_selection` had zero
// rows, so the pick → supervisor → admin chain had never been driven.
//
// `list` shows every selection to a school-wide role OR to a holder of
// `subject.selection.approve`. `review` refused anyone without that permission
// with a 404. A PRINCIPAL is school-wide and deliberately does NOT hold it —
// the final approval belongs to a school administrator or head teacher — so the
// most senior person in the school saw a pending queue on their own screen,
// pressed Approve, and was told the selection does not exist. Live: `list` 200
// with the row, `review` 404.
//
// 404-not-403 is the right rule and this is its other edge. It exists so a
// refusal cannot CONFIRM what it hides; it must equally not DENY what the
// product has already shown, which reads as a broken screen rather than as a
// boundary and sends somebody to support instead of to the right colleague.
//
// AND THE TERMINAL BRANCH LEAKED. `else throw new ConflictException("This
// selection is already " + status)` ran with no visibility check at all, behind
// a route gated on `class.read` — which every teacher holds. Live before this: a
// teacher whose own list returned ZERO rows put the id in and got
// `409 This selection is already APPROVED`, about a pupil in a class that is
// nothing to do with them.
// =============================================================================

import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { SubjectSelectionService } from "../../src/gradebook/subject-selection.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const SUPERVISOR = "u-supervisor";
const APPROVE = "subject.selection.approve";

const who = (roles: string[], permissions: string[] = [], userId = "u-x"): Principal => ({
  userId,
  schoolId: "school-1",
  roles,
  permissions,
});

const principal = who(["principal"], [], "u-principal");
const teacher = who(["teacher"], [], "u-teacher");
const admin = who(["school_admin"], [APPROVE], "u-admin");
const supervisor = who(["teacher"], [], SUPERVISOR);

function makeService(row: Record<string, unknown> | null) {
  const svc = Object.create(SubjectSelectionService.prototype) as SubjectSelectionService;
  const tx = {
    subjectSelection: {
      findFirst: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  Object.assign(svc, {
    db: { runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx)) },
    audit: { record: jest.fn() },
    ctx: () => ({ schoolId: "school-1", userId: "u" }),
    toDto: jest.fn().mockResolvedValue({}),
    notifications: { enqueue: jest.fn(), enqueueMany: jest.fn() },
  });
  return svc;
}

const pending = (status: string) => ({
  id: "sel-1",
  studentId: "pupil-1",
  supervisorId: SUPERVISOR,
  supervisorActedById: null,
  status,
});

describe("a caller who can SEE the selection", () => {
  it("is told WHO gives the final approval, not that it does not exist", async () => {
    // The principal's own queue is showing it.
    await expect(makeService(pending("PENDING_ADMIN")).review(principal, "sel-1", { action: "APPROVE" })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("names the role that can act, so the next click is the right one", async () => {
    await expect(
      makeService(pending("PENDING_ADMIN")).review(principal, "sel-1", { action: "APPROVE" }),
    ).rejects.toThrow(/school administrator or head teacher/);
  });

  it("is told a stage-1 item is with the supervisor, rather than nothing", async () => {
    await expect(makeService(pending("PENDING_SUPERVISOR")).review(principal, "sel-1", { action: "APPROVE" })).rejects.toThrow(
      /class supervisor/,
    );
  });

  it("still gets the CONFLICT for something already decided", async () => {
    await expect(makeService(pending("APPROVED")).review(principal, "sel-1", { action: "APPROVE" })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("a caller who CANNOT see it", () => {
  it("gets 404 at stage 1", async () => {
    await expect(makeService(pending("PENDING_SUPERVISOR")).review(teacher, "sel-1", { action: "APPROVE" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("gets 404 at stage 2", async () => {
    await expect(makeService(pending("PENDING_ADMIN")).review(teacher, "sel-1", { action: "APPROVE" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("gets 404 for a DECIDED one, never its status", async () => {
    // The leak: this branch had no visibility check at all, behind a route
    // every teacher can call. A 409 naming the status tells them the record
    // exists and what was decided about a pupil who is not theirs.
    const svc = makeService(pending("APPROVED"));
    await expect(svc.review(teacher, "sel-1", { action: "APPROVE" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.review(teacher, "sel-1", { action: "APPROVE" })).rejects.not.toThrow(/APPROVED/);
  });

  it("gets the SAME answer for a selection that does not exist at all", async () => {
    // Indistinguishable in status and in wording, or the refusal is a probe.
    await expect(makeService(null).review(teacher, "sel-1", { action: "APPROVE" })).rejects.toThrow("Selection not found");
  });
});

describe("the people who may actually act", () => {
  it("lets the named supervisor take stage 1", async () => {
    await expect(makeService(pending("PENDING_SUPERVISOR")).review(supervisor, "sel-1", { action: "APPROVE" })).resolves.toBeDefined();
  });

  it("lets an approver take stage 2", async () => {
    await expect(makeService(pending("PENDING_ADMIN")).review(admin, "sel-1", { action: "APPROVE" })).resolves.toBeDefined();
  });

  it("never lets a pupil review their own, whoever else they are", async () => {
    const self = who(["student"], [APPROVE], "pupil-1");
    await expect(makeService(pending("PENDING_ADMIN")).review(self, "sel-1", { action: "APPROVE" })).rejects.toThrow(
      /your own selection/,
    );
  });

  it("keeps the two stages in different hands", async () => {
    const row = { ...pending("PENDING_ADMIN"), supervisorActedById: admin.userId };
    await expect(makeService(row).review(admin, "sel-1", { action: "APPROVE" })).rejects.toThrow(/different person/);
  });
});
