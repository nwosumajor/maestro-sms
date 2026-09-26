// =============================================================================
// Who corrects a stale register — the claim that was false for two of three
// =============================================================================
// `markAttendance` reads `attendance.amend.review` into `isApprover` and branches
// on it, and both the code comment and CLAUDE.md said the same thing about what
// that means: "holders of attendance.amend.review edit stale registers DIRECTLY
// (they're the approvers)". Three roles hold that permission — head_teacher,
// school_admin, principal — and it was true of exactly one of them.
//
// BOTH branches call `assertCanTakeRegister`. `isApprover` chooses which branch,
// never whether the gate applies, so a correction is gated exactly like a fresh
// register: the class's own supervisor, or school_admin as cover. Measured live
// on a 10-day-old register:
//
//     teacher (the supervisor)   201  { pendingApproval: true }
//     school_admin               201  applied directly
//     principal                  403  "Only History 101's class teacher takes
//                                      its register — ask a school administrator"
//     head_teacher               403
//
// The decision was to keep the code and correct the claim: a register attests
// "I looked at this room", a correction is a claim about the same room, and
// amend.review exists so a senior can APPROVE a teacher's account of it rather
// than replace it. The principal holds `attendance.write` and is refused at ROW
// scope — the dead-grant shape this repo records, here deliberately.
//
// So this drives all four roles rather than reading the rule, because reading it
// is what produced a comment that disagreed with its own function for as long as
// it existed. `a-form-that-refuses-on-save` covers the same rule for TAKING a
// register; nothing covered it for CORRECTING one, which is why the claim about
// corrections could be wrong without a test noticing.
// =============================================================================

import { AttendanceService } from "../../src/attendance/attendance.service";
import { WORKFLOW_PERMISSIONS } from "@sms/types";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const CLASS = "c-1";
const SUPERVISOR = "u-supervisor";
const STUDENT = "s-1";

/** A date comfortably past STALE_REGISTER_DAYS, in the CURRENT term. */
const staleDay = () => new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);

function makeService() {
  const tx = {
    class: {
      findFirst: jest.fn().mockResolvedValue({ id: CLASS, name: "History 101", supervisorId: SUPERVISOR }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: {
      // Both shapes: `rollOn` reads the relation, other callers `studentId`.
      findMany: jest.fn().mockResolvedValue([{ studentId: STUDENT, student: { id: STUDENT, name: "Pupil" } }]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    parentChild: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    attendanceSession: {
      upsert: jest.fn().mockResolvedValue({ id: "sess-1" }),
      findFirst: jest.fn().mockResolvedValue({ id: "sess-1", records: [] }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    attendanceRecord: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    // The term started long before the stale date, so the term LOCK is not what
    // refuses anybody here — otherwise this would pass for the wrong reason.
    term: { findFirst: jest.fn().mockResolvedValue({ startDate: new Date(Date.now() - 120 * 86_400_000) }) },
    schoolHoliday: { findFirst: jest.fn().mockResolvedValue(null) },
    $executeRaw: jest.fn().mockResolvedValue(1),
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const workflow = {
    createRequest: jest.fn().mockResolvedValue({ id: "wf-1" }),
    submit: jest.fn().mockResolvedValue({ id: "wf-1" }),
  };
  const service = new AttendanceService(
    db as never,
    { record: jest.fn() } as never,
    { enqueue: jest.fn().mockResolvedValue({ id: "n-1" }), enqueueMany: jest.fn().mockResolvedValue({ created: 0, failed: 0 }) } as never,
    workflow as never,
    {
      forSchool: jest.fn().mockResolvedValue({ timezone: "Africa/Lagos" }),
      inTx: jest.fn().mockResolvedValue({ timezone: "Africa/Lagos" }),
      todayInTx: jest.fn(async () => new Date()),
    } as never,
    { onFinalized: jest.fn() } as never,
  );
  return { service, workflow, tx };
}

/** Every role that holds `attendance.amend.review` gets it here, so the only
 *  thing separating them in these tests is the row scope. */
const who = (roles: string[], userId = "u-them"): Principal => ({
  schoolId: "S",
  userId,
  roles,
  permissions: ["attendance.read", "attendance.write", WORKFLOW_PERMISSIONS.ATTENDANCE_AMEND_REVIEW],
});

const correct = (svc: AttendanceService, p: Principal) =>
  svc.markAttendance(p, CLASS, { date: staleDay(), records: [{ studentId: STUDENT, status: "PRESENT" }] } as never);

describe("correcting a register older than the window", () => {
  it("the class's own supervisor raises an amendment rather than applying it", async () => {
    // A plain teacher is not an approver, so the maker-checker branch. This is
    // the case the whole window exists for.
    const { service, workflow } = makeService();
    const p: Principal = { ...who(["teacher"], SUPERVISOR), permissions: ["attendance.read", "attendance.write"] };
    await expect(correct(service, p)).resolves.toMatchObject({ pendingApproval: true });
    expect(workflow.createRequest).toHaveBeenCalled();
  });

  it("school_admin applies it directly, as cover", async () => {
    const { service, workflow } = makeService();
    await expect(correct(service, who(["school_admin"]))).resolves.not.toMatchObject({ pendingApproval: true });
    expect(workflow.createRequest).not.toHaveBeenCalled();
  });

  it("the PRINCIPAL is refused, holding amend.review and attendance.write both", async () => {
    // The claim this file exists for. They pass the route gate and fail at row
    // scope, and the refusal names the way out rather than hiding the class.
    const { service } = makeService();
    await expect(correct(service, who(["principal"]))).rejects.toThrow(/class teacher takes its register/i);
  });

  it("the HEAD TEACHER is refused too", async () => {
    // Refused here at row scope; in the running app they do not hold
    // `attendance.write` either, so the route gate stops them first.
    const { service } = makeService();
    await expect(correct(service, who(["head_teacher"]))).rejects.toThrow();
  });

  it("holding amend.review does NOT let an approver author — it only picks the branch", async () => {
    // The property, stated directly: for a caller who is neither the supervisor
    // nor school_admin, the outcome is the same with and without the permission.
    // If `isApprover` ever came to mean "may write", this is what would notice.
    const { service } = makeService();
    const withPerm = who(["principal"]);
    const withoutPerm: Principal = { ...withPerm, permissions: ["attendance.read", "attendance.write"] };
    await expect(correct(service, withPerm)).rejects.toThrow();
    await expect(correct(service, withoutPerm)).rejects.toThrow();
  });

  it("refuses the approver BEFORE the term lock, so the message is about the right thing", async () => {
    // A refusal must not assert something untrue. Told "this term has ended"
    // when the real reason is cover, a principal would go looking for the wrong
    // fix — and the term here is deliberately still open.
    const { service } = makeService();
    await expect(correct(service, who(["principal"]))).rejects.toThrow(/class teacher/i);
  });
});
