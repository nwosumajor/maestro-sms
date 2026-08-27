/**
 * A raise takes effect when it says it does.
 *
 * `salary_change_request.effectiveDate` was accepted by the API, stored on the
 * row, returned in the DTO and shown on the screen — and consulted by NOTHING.
 * Approval applied `employee.salaryEnc` immediately and unconditionally.
 *
 * Proven live: a raise requested "effective 2026-10-01" and approved on
 * 2026-08-27 moved the salary on 2026-08-27 — five weeks early, and the next
 * payroll run would have paid it. The record said October and the money said
 * August.
 *
 * Same shape as the archive's `sessionId`, which was "accepted, stored on the
 * row, written into the manifest — and FILTERED NOTHING", except this one is
 * money leaving the school early.
 */
import { SalaryService } from "../../src/hr/salary.service";

const TODAY = new Date("2026-08-27T00:00:00.000Z");

function makeService(effectiveDate: Date | null) {
  const row = {
    id: "req-1", employeeId: "emp-1", schoolId: "A",
    oldSalaryEnc: "old", newSalaryEnc: "new", reason: null,
    effectiveDate, status: "PENDING", requestedById: "hr1",
    decidedById: null, decidedAt: null, createdAt: new Date(),
  };
  const changeUpdate = jest.fn().mockResolvedValue({ ...row, status: "APPROVED" });
  const employeeUpdate = jest.fn().mockResolvedValue({});
  const tx = {
    salaryChangeRequest: { findFirst: jest.fn().mockResolvedValue(row), update: changeUpdate },
    employee: { update: employeeUpdate },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const svc = new SalaryService(
    { runAsTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    { notifyPermissionHolders: jest.fn().mockResolvedValue(0), enqueueMany: jest.fn().mockResolvedValue({ created: 0, failed: 0 }) } as never,
    { todayInTx: jest.fn().mockResolvedValue(TODAY) } as never,
  );
  return { svc, changeUpdate, employeeUpdate };
}

const approver = { schoolId: "A", userId: "principal", roles: [], permissions: [] } as never;

describe("a raise that took effect when it said", () => {
  it("does NOT move the salary when the effective date is still ahead", async () => {
    const { svc, employeeUpdate } = makeService(new Date("2026-10-01T00:00:00.000Z"));
    await svc.decide(approver, "req-1", true);
    expect(employeeUpdate).not.toHaveBeenCalled();
  });

  it("records the approval as not yet in force", async () => {
    // APPROVED with a null appliedAt is the whole state: the decision is made,
    // the money has not moved, and the sweep knows there is something to do.
    const { svc, changeUpdate } = makeService(new Date("2026-10-01T00:00:00.000Z"));
    await svc.decide(approver, "req-1", true);
    expect(changeUpdate.mock.calls[0][0].data).toMatchObject({ status: "APPROVED", appliedAt: null });
  });

  it("moves the salary at once when the date has arrived", async () => {
    const { svc, employeeUpdate, changeUpdate } = makeService(new Date("2026-08-01T00:00:00.000Z"));
    await svc.decide(approver, "req-1", true);
    expect(employeeUpdate).toHaveBeenCalledWith({ where: { id: "emp-1" }, data: { salaryEnc: "new" } });
    expect(changeUpdate.mock.calls[0][0].data.appliedAt).toBeInstanceOf(Date);
  });

  it("moves the salary at once when no date was given", async () => {
    // The common case, and it must behave exactly as it always has.
    const { svc, employeeUpdate } = makeService(null);
    await svc.decide(approver, "req-1", true);
    expect(employeeUpdate).toHaveBeenCalled();
  });

  it("treats the effective date as ARRIVING on its own day", async () => {
    // A date is a DAY. Approving on the effective date itself puts it in force
    // that day, not the next.
    const { svc, employeeUpdate } = makeService(TODAY);
    await svc.decide(approver, "req-1", true);
    expect(employeeUpdate).toHaveBeenCalled();
  });

  it("never applies anything on a rejection", async () => {
    const { svc, employeeUpdate, changeUpdate } = makeService(null);
    await svc.decide(approver, "req-1", false);
    expect(employeeUpdate).not.toHaveBeenCalled();
    expect(changeUpdate.mock.calls[0][0].data).toMatchObject({ status: "REJECTED", appliedAt: null });
  });
});
