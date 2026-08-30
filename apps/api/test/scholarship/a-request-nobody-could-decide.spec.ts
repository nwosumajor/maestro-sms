// =============================================================================
// A scholarship request parked in a state nobody could leave
// =============================================================================
// The student-initiated chain is supervisor -> guardian -> principal, and
// `submit` set PENDING_SUPERVISOR unconditionally. Stage 1 can only be decided
// by a CLASS TEACHER of a class the pupil is actively enrolled in.
//
// A class with no teacher therefore produced a request that nobody could act on.
// Measured in the demo database: 30 of 31 classes have no class teacher, and 899
// pupils are enrolled only in such classes. It is the default, not an edge.
//
// Verified against the running system, one request submitted from an
// unsupervised class:
//
//     teacher       404   does not supervise it — nobody does
//     principal     404   no override at this stage
//     school_admin  403   lacks scholarship.apply
//     head_teacher  403   same
//     hr_manager    403   same
//     owner         400   "has not completed its school approval"
//
// Six roles, no way forward, and the notification went to the supervisors who do
// not exist — so it was silent as well as stuck.
//
// THE FIX IS THE ONE THIS CODEBASE ALREADY CHOSE for subject selections: fail
// open to the next stage, and make the skip VISIBLE. A PENDING_PARENT that was
// skipped must not read like one a teacher passed — a chain that quietly becomes
// two stages should not look like three.
// =============================================================================

import { scholarshipSupervisorStage } from "@sms/types";
import { ScholarshipService } from "../../src/scholarship/scholarship.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const PUPIL: Principal = { schoolId: "A", userId: "pupil-1", roles: ["student"], permissions: ["scholarship.apply"] };

function make(opts: { classes: string[]; supervised: boolean }) {
  const update = jest.fn(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "app-1", studentId: "pupil-1", ...data }),
  );
  const tx = {
    enrollment: { findMany: jest.fn().mockResolvedValue(opts.classes.map((classId) => ({ classId }))) },
    // One definition of who teaches a class — see common/teaches.ts. The class
    // SUPERVISOR is the class teacher, so `supervised` is answered here.
    class: {
      findMany: jest.fn(({ where }: { where?: { id?: { in: string[] } } } = {}) =>
        Promise.resolve(
          where?.id?.in
            ? where.id.in.map((id) => ({ id, supervisorId: opts.supervised ? "sup-1" : null }))
            : [],
        ),
      ),
    },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    scholarshipApplication: { update },
  } as unknown as TenantTx;
  const s = Object.create(ScholarshipService.prototype) as ScholarshipService;
  Object.assign(s, {
    db: { runAsTenant: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)) },
    audit: { record: jest.fn() },
    notifications: {},
    region: {},
  });
  (s as unknown as { log: unknown }).log = jest.fn();
  (s as unknown as { ownDraft: unknown }).ownDraft = jest.fn().mockResolvedValue({
    id: "app-1", studentId: "pupil-1", applicantRole: "student", answers: { reason: "please" }, consentAt: null,
  });
  (s as unknown as { collectSignals: unknown }).collectSignals = jest.fn().mockResolvedValue({});
  (s as unknown as { toApplicationDtos: unknown }).toApplicationDtos = jest
    .fn()
    .mockResolvedValue([{ studentName: "Ada" }]);
  const notifyGuardians = jest.fn().mockResolvedValue(undefined);
  const notifySupervisors = jest.fn().mockResolvedValue(undefined);
  (s as unknown as { notifyGuardians: unknown }).notifyGuardians = notifyGuardians;
  (s as unknown as { notifySupervisors: unknown }).notifySupervisors = notifySupervisors;
  return { s, tx, update, notifyGuardians, notifySupervisors };
}

describe("submitting a request from a class WITH a supervisor", () => {
  it("goes to that supervisor, as it always did", async () => {
    const { s, update, notifySupervisors, notifyGuardians } = make({ classes: ["c1"], supervised: true });
    await s.submit(PUPIL, "app-1");
    expect(update.mock.calls[0][0].data.status).toBe("PENDING_SUPERVISOR");
    expect(notifySupervisors).toHaveBeenCalled();
    expect(notifyGuardians).not.toHaveBeenCalled();
  });
});

describe("submitting from a class with NO supervisor", () => {
  it("skips to the guardian rather than parking where nobody can act", async () => {
    const { s, update } = make({ classes: ["c1"], supervised: false });
    await s.submit(PUPIL, "app-1");
    expect(update.mock.calls[0][0].data.status).toBe("PENDING_PARENT");
  });

  it("tells the GUARDIAN, who is now the one who must act", async () => {
    // The old path notified supervisors who do not exist, so the request was
    // silent as well as stuck.
    const { s, notifyGuardians, notifySupervisors } = make({ classes: ["c1"], supervised: false });
    await s.submit(PUPIL, "app-1");
    expect(notifySupervisors).not.toHaveBeenCalled();
    expect(notifyGuardians).toHaveBeenCalled();
    expect(String(notifyGuardians.mock.calls[0][3])).toContain("no supervisor");
  });

  it("does the same for a pupil with no active enrolment at all", async () => {
    // Six such pupils in the demo database. Nobody supervises a pupil who is in
    // no class, and the old code sent them to stage 1 regardless.
    const { s, update, tx } = make({ classes: [], supervised: false });
    await s.submit(PUPIL, "app-1");
    expect(update.mock.calls[0][0].data.status).toBe("PENDING_PARENT");
    // And does not even ask — there are no classes to ask about.
    expect(tx.classSubjectTeacher.findMany).not.toHaveBeenCalled();
  });
});

describe("what the skip looks like afterwards", () => {
  it("is reported as SKIPPED, never as a stage somebody passed", () => {
    // Derived from the row, never stored, so it cannot drift from it.
    expect(scholarshipSupervisorStage({ status: "PENDING_PARENT", supervisorById: null, supervisorAt: null }))
      .toBe("SKIPPED_NO_SUPERVISOR");
  });

  it("still reports PASSED when a supervisor actually acted", () => {
    expect(scholarshipSupervisorStage({ status: "PENDING_PARENT", supervisorById: "t1", supervisorAt: new Date() }))
      .toBe("PASSED");
  });

  it("reports PENDING while it is genuinely waiting on one", () => {
    expect(scholarshipSupervisorStage({ status: "PENDING_SUPERVISOR", supervisorById: null, supervisorAt: null }))
      .toBe("PENDING");
  });

  it("treats a named-but-never-acted supervisor as skipped", () => {
    // The class supervisor changed after submission: the stage the row moved
    // past is not one anybody performed.
    expect(scholarshipSupervisorStage({ status: "PENDING_PRINCIPAL", supervisorById: "t1", supervisorAt: null }))
      .toBe("SKIPPED_NO_SUPERVISOR");
  });
});
