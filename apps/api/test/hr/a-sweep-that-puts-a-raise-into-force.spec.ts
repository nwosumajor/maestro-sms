/**
 * The nightly HR sweep, which had no test of any kind.
 *
 * It closes the access of departed staff and — now — puts an approved raise into
 * force on its effective date. A future-dated approval is deliberately NOT
 * applied at approval time, because `effectiveDate` used to be recorded and
 * ignored: a raise dated for October moved the salary in August and payroll
 * paid it. This is the arm that makes the date real, so it is the arm that must
 * not double-pay.
 */
import { StaffReminderService } from "../../src/hr/staff-reminder.service";

const OCT = new Date("2026-10-01T00:00:00.000Z");
const AUG = new Date("2026-08-01T00:00:00.000Z");

function makeSweep(opts: { due: Array<{ id: string; effectiveDate: Date }>; claimed?: number }) {
  const salaryUpdateMany = jest.fn().mockResolvedValue({ count: opts.claimed ?? 1 });
  const employeeUpdate = jest.fn().mockResolvedValue({});
  const client = {
    staffExit: { findMany: jest.fn().mockResolvedValue([]) },
    user: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    salaryChangeRequest: {
      findMany: jest.fn().mockResolvedValue(
        opts.due.map((d) => ({
          id: d.id, schoolId: "A", employeeId: `emp-${d.id}`,
          newSalaryEnc: "new", effectiveDate: d.effectiveDate,
        })),
      ),
      updateMany: salaryUpdateMany,
    },
    // A REAL privileged client always has this: the contract arm now runs on
    // every sweep (it used to sit behind an early return in the document arm),
    // so a fixture without it models something the database cannot produce.
    employee: { update: employeeUpdate, findMany: jest.fn().mockResolvedValue([]) },
    staffDocument: { findMany: jest.fn().mockResolvedValue([]) },
    employmentChangeRequest: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const svc = new StaffReminderService(
    { client } as never,
    { enqueueMany: jest.fn().mockResolvedValue({ created: 0, failed: 0 }), notifyPermissionHolders: jest.fn().mockResolvedValue(0) } as never,
    // The school's day — 27 August, so an October date has not arrived.
    { forSchool: jest.fn().mockResolvedValue({ timezone: "UTC" }) } as never,
  );
  return { svc, salaryUpdateMany, employeeUpdate };
}

describe("a sweep that puts a raise into force", () => {
  it("applies a change whose effective date has arrived", async () => {
    const { svc, employeeUpdate } = makeSweep({ due: [{ id: "r1", effectiveDate: AUG }] });
    const res = await svc.sweep();
    expect(employeeUpdate).toHaveBeenCalledWith({ where: { id: "emp-r1" }, data: { salaryEnc: "new" } });
    expect(res.salaryChangesApplied).toBe(1);
  });

  it("leaves a change whose date is still ahead", async () => {
    // The sweep re-checks against the SCHOOL's day rather than trusting the
    // query's `lte: now`, which is only a generous prefilter.
    const { svc, employeeUpdate } = makeSweep({ due: [{ id: "r1", effectiveDate: OCT }] });
    const res = await svc.sweep();
    expect(employeeUpdate).not.toHaveBeenCalled();
    expect(res.salaryChangesApplied).toBe(0);
  });

  it("CLAIMS the row before paying, so two runs cannot both apply it", async () => {
    // The guard is in the WRITE, not only the read. Without it an overlapping
    // run would pay the same raise twice, and nothing in the suite noticed when
    // it was removed.
    const { svc, salaryUpdateMany } = makeSweep({ due: [{ id: "r1", effectiveDate: AUG }] });
    await svc.sweep();
    expect(salaryUpdateMany).toHaveBeenCalledWith({
      where: { id: "r1", appliedAt: null },
      data: { appliedAt: expect.any(Date) },
    });
  });

  it("does not pay when another run claimed it first", async () => {
    const { svc, employeeUpdate } = makeSweep({ due: [{ id: "r1", effectiveDate: AUG }], claimed: 0 });
    const res = await svc.sweep();
    expect(employeeUpdate).not.toHaveBeenCalled();
    expect(res.salaryChangesApplied).toBe(0);
  });

  it("asks only for APPROVED changes that are not yet applied", async () => {
    // The read is half the idempotency: a query that returned every approved
    // change would re-apply history on its first run. The other half is the
    // claim above.
    const { svc } = makeSweep({ due: [] });
    await svc.sweep();
    const where = (svc as unknown as { db: { client: { salaryChangeRequest: { findMany: jest.Mock } } } })
      .db.client.salaryChangeRequest.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "APPROVED", appliedAt: null });
    expect(where.effectiveDate).toMatchObject({ not: null });
  });
});
