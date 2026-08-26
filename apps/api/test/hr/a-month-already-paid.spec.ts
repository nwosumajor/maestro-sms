// =============================================================================
// A final month the school had already paid
// =============================================================================
// `computeFinalSettlement` pays `base × day / daysInMonth` for the final month
// and nothing asked whether payroll had already covered it. Most schools run
// payroll before month end: on the 25th, a leaver whose last day is the 28th
// had already had the WHOLE month, and the settlement paid 28/31 of it AGAIN —
// on ₦300,000 a second ₦270,967.74 for a month already discharged.
//
// The pure helper is tested beside the other payroll maths. THIS drives the
// SERVICE, because a test on a helper proves nothing about its caller — the
// seam that hid the CBT score and the report-card promotion-line bugs.
// =============================================================================

import { ExitService } from "../../src/hr/exit.service";
import { decryptField, encryptField } from "../../src/foundation/field-crypto";

const SCHOOL = "school-a";
const USER = "leaver-1";

function makeService(opts: { runs: Array<Record<string, unknown>>; payslip: boolean }) {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    employee: {
      // Encrypted the way the service writes it, so it round-trips whether or
      // not DATA_ENCRYPTION_KEY is set in this environment.
      findFirst: jest.fn().mockResolvedValue({
        id: "e1",
        userId: USER,
        status: "ACTIVE",
        salaryEnc: encryptField(String(30_000_000), SCHOOL),
      }),
    },
    staffExit: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return { id: "x1", ...a.data };
      }),
    },
    leaveBalance: { findMany: jest.fn().mockResolvedValue([{ entitledDays: 6, usedDays: 0 }]) },
    staffLoan: { findMany: jest.fn().mockResolvedValue([]) },
    payrollRun: { findMany: jest.fn().mockResolvedValue(opts.runs) },
    payslip: { findFirst: jest.fn().mockResolvedValue(opts.payslip ? { id: "ps1" } : null) },
  };

  const svc = Object.create(ExitService.prototype) as ExitService;
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx) },
    audit: { record: jest.fn() },
  });
  // The settlement is snapshotted ENCRYPTED, so the assertion reads it back the
  // way the service wrote it rather than trusting a plaintext field.
  (svc as unknown as { toDto: unknown }).toDto = jest.fn(async () => ({}));
  return { svc, tx, created };
}

const hr = { schoolId: SCHOOL, userId: "hr-1", roles: ["hr_manager"], permissions: ["hr.write"] } as never;

const initiate = (svc: ExitService) =>
  svc.initiate(hr, { userId: USER, type: "RESIGNATION", lastWorkingDay: "2026-08-28" });

/** The encrypted snapshot, read back. */
function settlementOf(created: Array<Record<string, unknown>>) {
  return JSON.parse(decryptField(created[0].settlementEnc as string, SCHOOL));
}

const AUGUST_RUN = { id: "r1" };

describe("initiating an exit", () => {
  it("pays the pro-rata when that month's payroll has NOT run", async () => {
    const t = makeService({ runs: [], payslip: false });
    await initiate(t.svc);
    const s = settlementOf(t.created);
    expect(s.finalMonthAlreadyPaid).toBe(false);
    expect(s.proRataMinor).toBe(27_096_774); // 28/31 × ₦300,000
  });

  it("pays nothing more for the month when a FINALIZED MONTHLY run already covered it", async () => {
    const t = makeService({ runs: [AUGUST_RUN], payslip: true });
    await initiate(t.svc);
    const s = settlementOf(t.created);
    expect(s.finalMonthAlreadyPaid).toBe(true);
    expect(s.proRataMinor).toBe(0);
    // Accrued leave is not month-bound and is still owed.
    expect(s.leavePayoutMinor).toBeGreaterThan(0);
  });

  it("asks about the LAST WORKING DAY's month, MONTHLY and FINALIZED only", async () => {
    // A THIRTEENTH or BONUS run pays base without being salary FOR that month —
    // its own schema comment says so — and a DRAFT run has paid nobody.
    // Counting either as payment swings the error the other way and shorts the
    // leaver, which is the worse direction.
    const t = makeService({ runs: [AUGUST_RUN], payslip: true });
    await initiate(t.svc);
    expect(t.tx.payrollRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runType: "MONTHLY",
          status: "FINALIZED",
          periodYear: 2026,
          periodMonth: 8,
        }),
      }),
    );
  });

  it("does not look for a payslip at all when no run covers the month", async () => {
    const t = makeService({ runs: [], payslip: false });
    await initiate(t.svc);
    expect(t.tx.payslip.findFirst).not.toHaveBeenCalled();
  });

  it("looks for THIS person's payslip, not just any", async () => {
    // A run existing is not the same as this leaver having been in it — a
    // member of staff who joined on the 26th is in no August run.
    const t = makeService({ runs: [AUGUST_RUN], payslip: false });
    await initiate(t.svc);
    expect(t.tx.payslip.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: USER }) }),
    );
    expect(settlementOf(t.created).finalMonthAlreadyPaid).toBe(false);
  });
});
