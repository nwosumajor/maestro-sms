// =============================================================================
// Everyone who could read the register could rewrite their own attendance
// =============================================================================
// `hr.read` and `hr.write` were held by exactly the same four roles — principal,
// school_admin, hr_clerk, hr_manager — and `mark()` was a plain upsert on any
// `userId` and any `date`:
//
//     tx.staffAttendance.upsert({ where: { userId_date: { userId, date } }, ... })
//
// So anybody who could see the register could write or rewrite ANY mark for ANY
// person on ANY date, including their own and including last year, with no
// step-up and no second signature. That is the record read back as evidence in a
// lateness conversation and cited in a disciplinary file.
//
// Salary changes are maker-checker here. Payroll finalise is maker-checker.
// Amending a PUPIL register past seven days needs a second approver. The staff
// register had none of it.
//
// Two controls now: nobody marks themselves at all, and a correction older than
// the window goes through a second SENIOR pair of eyes.
// =============================================================================

import { StaffAttendanceService } from "../../src/hr/attendance.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const TZ = "Africa/Lagos";
const NOW = new Date("2026-08-19T09:00:00.000Z");

const clerk: Principal = {
  schoolId: "S",
  userId: "clerk-1",
  roles: ["hr_clerk"],
  permissions: ["hr.attendance.read", "hr.attendance.amend"],
};

function makeService() {
  const upserts: Array<{ status: string }> = [];
  const tx = {
    employee: { findFirst: jest.fn(async () => ({ id: "emp-1" })) },
    // The request now NAMES the person, because a date alone cannot support the
    // decision. A double missing this fails as a code fault.
    user: { findFirst: jest.fn(async () => ({ name: "Amaka Obi" })) },
    staffAttendance: {
      upsert: jest.fn(async (a: { create: { status: string } }) => {
        upserts.push({ status: a.create.status });
        return { id: "row", userId: "staff-2", date: new Date(), status: a.create.status, source: "ADMIN", clockInAt: null, clockOutAt: null, flagged: false, note: null };
      }),
    },
  } as unknown as TenantTx;
  // Typed so the assertions can read what was ASKED FOR — an untyped jest.fn()
  // gives `calls[0][1]` a zero-length tuple and the spec will not compile.
  const workflow = {
    createRequest: jest.fn(
      async (_p: Principal, _input: { type: string; title: string; payload: Record<string, unknown>; stages: Array<{ permission: string }> }) => ({ id: "req-1" }),
    ),
    submit: jest.fn(async (_p: Principal, _id: string) => ({})),
  };
  const svc = new StaffAttendanceService(
    { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) } as never,
    { record: jest.fn() } as never,
    { forSchool: async () => ({ timezone: TZ }), inTx: async () => ({ timezone: TZ }), todayInTx: async () => new Date() } as never,
    workflow as never,
    { onFinalized: jest.fn() } as never,
  );
  return { svc, workflow, upserts };
}

beforeEach(() => jest.useFakeTimers({ doNotFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] }));
beforeEach(() => jest.setSystemTime(NOW));
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("marking somebody else's attendance", () => {
  it("REFUSES to let anyone mark their own", async () => {
    // Refused outright rather than flagged: there is no legitimate case for it,
    // and a signal nobody reviews is not a control.
    const { svc, upserts } = makeService();
    await expect(svc.mark(clerk, { userId: clerk.userId, date: "2026-08-19", status: "PRESENT" })).rejects.toThrow(
      /cannot mark your own attendance/i,
    );
    expect(upserts).toEqual([]);
  });

  it("names the way out rather than just refusing", async () => {
    // A refusal that does not say what to do next sends somebody to the office.
    const { svc } = makeService();
    await expect(svc.mark(clerk, { userId: clerk.userId, date: "2026-08-19", status: "PRESENT" })).rejects.toThrow(
      /another attendance approver/i,
    );
  });

  it("applies a correction inside the window directly", async () => {
    const { svc, workflow, upserts } = makeService();
    const out = await svc.mark(clerk, { userId: "staff-2", date: "2026-08-17", status: "LATE" });
    expect(upserts).toHaveLength(1);
    expect(workflow.createRequest).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty("pendingApproval");
  });
});

describe("a correction older than the window", () => {
  it("raises a maker-checker request instead of writing", async () => {
    const { svc, workflow, upserts } = makeService();
    const out = await svc.mark(clerk, { userId: "staff-2", date: "2026-06-01", status: "PRESENT" });
    expect(upserts).toEqual([]);
    expect(out).toMatchObject({ pendingApproval: true, requestId: "req-1" });
    expect(workflow.createRequest).toHaveBeenCalled();
    expect(workflow.submit).toHaveBeenCalled();
  });

  it("routes it to the SENIOR reviewer permission, not the one that raised it", async () => {
    // An hr_clerk's late correction should reach a manager, not another clerk.
    const { svc, workflow } = makeService();
    await svc.mark(clerk, { userId: "staff-2", date: "2026-06-01", status: "PRESENT" });
    const stages = workflow.createRequest.mock.calls[0][1].stages as Array<{ permission: string }>;
    expect(stages).toHaveLength(1);
    expect(stages[0].permission).toBe("hr.attendance.amend.review");
  });

  it("carries what it is asking for, so an approver can see the decision", async () => {
    const { svc, workflow } = makeService();
    await svc.mark(clerk, { userId: "staff-2", date: "2026-06-01", status: "ABSENT", note: "no show" });
    expect(workflow.createRequest.mock.calls[0][1].payload).toMatchObject({
      userId: "staff-2",
      date: "2026-06-01",
      status: "ABSENT",
      note: "no show",
    });
  });

  it("SAYS WHOSE ATTENDANCE, and to what — the inbox renders only the summary", async () => {
    // "Staff attendance amendment — 2026-06-01" names neither the person nor the
    // change. An approver countersigning a claim about a colleague's attendance
    // record cannot do it from a date.
    const { svc, workflow } = makeService();
    await svc.mark(clerk, { userId: "staff-2", date: "2026-06-01", status: "ABSENT", note: "no show" });
    const { payload, title } = workflow.createRequest.mock.calls[0][1];
    expect(payload.summary).toContain("Amaka Obi");
    expect(payload.summary).toContain("2026-06-01");
    expect(payload.summary).toContain("absent");
    expect(payload.summary).toContain("no show");
    expect(title).toContain("Amaka Obi");
  });

  it("refuses a non-employee BEFORE spending a reviewer's time", async () => {
    const { svc, workflow } = makeService();
    const tx = { employee: { findFirst: jest.fn(async () => null) } } as unknown as TenantTx;
    const svc2 = new StaffAttendanceService(
      { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) } as never,
      { record: jest.fn() } as never,
      { forSchool: async () => ({ timezone: TZ }) } as never,
      workflow as never,
      { onFinalized: jest.fn() } as never,
    );
    await expect(svc2.mark(clerk, { userId: "ghost", date: "2026-06-01", status: "PRESENT" })).rejects.toThrow(
      /Active employee record not found/,
    );
    expect(workflow.createRequest).not.toHaveBeenCalled();
    void svc;
  });
});
