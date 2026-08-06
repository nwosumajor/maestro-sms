// =============================================================================
// PayrollService — run snapshot + finalize unit tests
// =============================================================================

import { PayrollService } from "../../src/hr/payroll.service";
import { computeMonthlyPayslip } from "@sms/types";
import { encryptField } from "../../src/foundation/field-crypto";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

beforeAll(() => {
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
});
afterAll(() => {
  delete process.env.DATA_ENCRYPTION_KEY;
});

/** Where the school is. Nigeria by default, so every existing assertion here is
 *  unchanged; `country` puts it somewhere payroll is not implemented. */
const regionFake = (country = "NG", payrollPack: string | null = "NG") => ({
  forSchool: jest.fn().mockResolvedValue({ country, payrollPack, timezone: "Africa/Lagos" }),
});

function makeService(over: {
  dup?: Record<string, unknown> | null;
  employees?: Array<Record<string, unknown>>;
  run?: Record<string, unknown> | null;
  components?: Array<Record<string, unknown>>;
  users?: Array<{ id: string; name: string }>;
  /** Where the school is. Defaults to Nigeria, so existing assertions stand. */
  country?: string;
  payrollPack?: string | null;
} = {}) {
  const payslipCreate = jest.fn().mockResolvedValue({});
  const runUpdate = jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "run1", periodYear: 2026, periodMonth: 1, status: "DRAFT", totalGrossMinor: 0, totalNetMinor: 0, createdAt: new Date(), finalizedAt: null, ...args.data }));
  const tx = {
    payrollRun: {
      findFirst: jest.fn().mockResolvedValue(over.run ?? over.dup ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "run1", periodYear: 2026, periodMonth: 1, status: "DRAFT", totalGrossMinor: 0, totalNetMinor: 0, createdAt: new Date(), finalizedAt: null }),
      update: runUpdate,
      updateMany: jest.fn(() =>
        Promise.resolve({ count: (over.run as { status?: string } | null | undefined)?.status === "DRAFT" ? 1 : 0 }),
      ),
    },
    payslip: { create: payslipCreate, findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    employee: { findMany: jest.fn().mockResolvedValue(over.employees ?? []) },
    user: { findMany: jest.fn().mockResolvedValue(over.users ?? []) },
    payComponent: { findMany: jest.fn().mockResolvedValue(over.components ?? []) },
    staffLoan: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
    loanRepayment: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const region = regionFake(over.country ?? "NG", over.payrollPack === undefined ? "NG" : over.payrollPack);
  return { service: new PayrollService(db as never, audit as never, region as never), payslipCreate, runUpdate, region };
}

const p = (userId = "hr1"): Principal => ({ schoolId: "A", userId, roles: [], permissions: [] });

describe("PayrollService", () => {
  it("createRun snapshots active employees into encrypted payslips and totals gross", async () => {
    const { service, payslipCreate, runUpdate } = makeService({
      dup: null,
      employees: [
        { id: "e1", userId: "u1", salaryEnc: encryptField("500000", "A") },
        { id: "e2", userId: "u2", salaryEnc: encryptField("300000", "A") },
      ],
    });
    const run = await service.createRun(p(), 2026, 1);
    expect(payslipCreate).toHaveBeenCalledTimes(2);
    const firstSlip = payslipCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(firstSlip.grossEnc as string).toMatch(/^enc:v1:/); // amounts encrypted at rest
    const expectedNet = computeMonthlyPayslip(500000).netMinor + computeMonthlyPayslip(300000).netMinor;
    expect(runUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { totalGrossMinor: 800000, totalNetMinor: expectedNet } }));
    expect(run.totalGrossMinor).toBe(800000);
    expect(expectedNet).toBeLessThan(800000); // statutory deductions applied
  });

  it("createRun REFUSES the whole run when a deduction exceeds an employee's pay (names them, persists nothing)", async () => {
    const { service, payslipCreate } = makeService({
      dup: null,
      employees: [
        { id: "e1", userId: "u1", salaryEnc: encryptField("10000000", "A") }, // ₦100k/mo
      ],
      // A ₦200k deduction against ₦100k pay → net would be negative.
      components: [{ id: "c1", userId: "u1", kind: "DEDUCTION", name: "Damages", amountMinor: 20000000, active: true }],
      users: [{ id: "u1", name: "Ada Staff" }],
    });
    await expect(service.createRun(p(), 2026, 1)).rejects.toThrow(/deductions exceed pay.*Ada Staff/i);
    expect(payslipCreate).not.toHaveBeenCalled(); // nothing persisted
  });

  it("createRun refuses a duplicate period (409)", async () => {
    const { service } = makeService({ dup: { id: "existing" } });
    await expect(service.createRun(p(), 2026, 1)).rejects.toThrow(/already exists/i);
  });

  it("createRun rejects an invalid month", async () => {
    const { service } = makeService({});
    await expect(service.createRun(p(), 2026, 13)).rejects.toThrow(/month/i);
  });

  it("finalizeRun is maker-checker: the creator can't finalize, a different person can", async () => {
    const own = makeService({ run: { id: "run1", status: "DRAFT", runById: "hr1", periodYear: 2026, periodMonth: 1, totalGrossMinor: 0, totalNetMinor: 0, createdAt: new Date(), finalizedAt: null } });
    await expect(own.service.finalizeRun(p("hr1"), "run1")).rejects.toThrow(/different person/i);

    const ok = makeService({ run: { id: "run1", status: "DRAFT", runById: "hr1", periodYear: 2026, periodMonth: 1, totalGrossMinor: 0, totalNetMinor: 0, createdAt: new Date(), finalizedAt: null } });
    const finalized = await ok.service.finalizeRun(p("hr2"), "run1");
    expect(finalized.id).toBe("run1"); // atomic DRAFT->FINALIZED flip succeeded (updateMany count=1)
  });

  it("finalizeRun refuses to re-finalize", async () => {
    const already = makeService({ run: { id: "run1", status: "FINALIZED", runById: "hr1", periodYear: 2026, periodMonth: 1, totalGrossMinor: 0, totalNetMinor: 0, createdAt: new Date(), finalizedAt: new Date() } });
    await expect(already.service.finalizeRun(p("hr2"), "run1")).rejects.toThrow(/already finalized/i);
  });
});

describe("computeMonthlyPayslip (PAYE + pension, pure)", () => {
  it("net = gross − deductions, and deductions include the 8% pension", () => {
    const bd = computeMonthlyPayslip(500000); // ₦5,000/mo
    expect(bd.netMinor).toBe(bd.grossMinor - bd.deductionsMinor);
    expect(bd.pensionMinor).toBe(Math.round(500000 * 12 * 0.08 / 12));
    expect(bd.deductionsMinor).toBeGreaterThanOrEqual(bd.pensionMinor);
  });
  it("a high earner pays PAYE (> 0); a zero salary owes nothing", () => {
    expect(computeMonthlyPayslip(5_000_000_00).payeMinor).toBeGreaterThan(0);
    expect(computeMonthlyPayslip(0)).toMatchObject({ grossMinor: 0, payeMinor: 0, pensionMinor: 0, netMinor: 0 });
  });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
import { computeBonusPayslip, computeFullPayslip, employerPensionMinor } from "@sms/types";

describe("computeFullPayslip (allowances + deductions + loan recovery, pure)", () => {
  it("gross = base + allowances; statutory computed on the full gross", () => {
    const bare = computeFullPayslip({ baseMinor: 200_000_00 });
    expect(bare.grossMinor).toBe(200_000_00);
    expect(bare.netMinor).toBe(computeMonthlyPayslip(200_000_00).netMinor);

    const withAllow = computeFullPayslip({
      baseMinor: 150_000_00,
      allowances: [
        { name: "Housing", amountMinor: 30_000_00 },
        { name: "Transport", amountMinor: 20_000_00 },
      ],
    });
    expect(withAllow.grossMinor).toBe(200_000_00);
    // Same gross → same statutory as the bare 200k case.
    expect(withAllow.payeMinor).toBe(bare.payeMinor);
    expect(withAllow.pensionMinor).toBe(bare.pensionMinor);
  });

  it("applies other deductions and loan installments after statutory", () => {
    const r = computeFullPayslip({
      baseMinor: 200_000_00,
      otherDeductions: [{ name: "Co-op", amountMinor: 10_000_00 }],
      loanInstallments: [{ loanId: "L1", installmentMinor: 15_000_00 }],
    });
    const statutory = computeMonthlyPayslip(200_000_00);
    expect(r.deductionsMinor).toBe(statutory.deductionsMinor + 10_000_00 + 15_000_00);
    expect(r.netMinor).toBe(r.grossMinor - r.deductionsMinor);
    expect(r.loans).toEqual([{ loanId: "L1", installmentMinor: 15_000_00 }]);
  });

  it("CLAMPS loan recovery so net never goes below zero (partial recovery)", () => {
    const r = computeFullPayslip({
      baseMinor: 50_000_00,
      otherDeductions: [{ name: "Co-op", amountMinor: 40_000_00 }],
      loanInstallments: [{ loanId: "L1", installmentMinor: 100_000_00 }],
    });
    expect(r.netMinor).toBe(0); // loan took only what was available
    expect(r.loans[0].installmentMinor).toBeLessThan(100_000_00);
    expect(r.loans[0].installmentMinor).toBeGreaterThan(0);
  });

  it("drops zero/negative lines and handles multiple loans in order", () => {
    const r = computeFullPayslip({
      baseMinor: 300_000_00,
      allowances: [{ name: "Empty", amountMinor: 0 }],
      loanInstallments: [
        { loanId: "A", installmentMinor: 5_000_00 },
        { loanId: "B", installmentMinor: 5_000_00 },
      ],
    });
    expect(r.allowances).toEqual([]);
    expect(r.loans.map((l) => l.loanId)).toEqual(["A", "B"]);
  });
});

describe("computeBonusPayslip (13th month / bonus, pure)", () => {
  it("13th month = 100% of basic, PAYE applies, NO pension/components/loans", () => {
    const r = computeBonusPayslip(20_000_000, 100);
    expect(r.grossMinor).toBe(20_000_000);
    expect(r.pensionMinor).toBe(0);
    expect(r.allowances).toEqual([]);
    expect(r.loans).toEqual([]);
    expect(r.payeMinor).toBe(computeMonthlyPayslip(20_000_000).payeMinor);
    expect(r.netMinor).toBe(r.grossMinor - r.payeMinor);
  });
  it("bonus percent scales the basic and clamps garbage", () => {
    expect(computeBonusPayslip(20_000_000, 50).grossMinor).toBe(10_000_000);
    expect(computeBonusPayslip(20_000_000, -5).grossMinor).toBe(0);
    expect(computeBonusPayslip(20_000_000, 5000).grossMinor).toBe(200_000_000); // capped at 1000%
  });
});

describe("employerPensionMinor (pure)", () => {
  it("is 10% of gross, floored at 0", () => {
    expect(employerPensionMinor(20_000_000)).toBe(2_000_000);
    expect(employerPensionMinor(-5)).toBe(0);
  });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
import { computeFinalSettlement } from "@sms/types";

describe("computeFinalSettlement (exit, pure)", () => {
  it("pro-rata + leave payout − loan recovery", () => {
    // ₦300k basic, leaving 15 June (15/30 of the month), 6 leave days left, ₦50k loan.
    const s = computeFinalSettlement({
      baseMinor: 30_000_000,
      lastWorkingDay: "2026-06-15",
      leaveDaysRemaining: 6,
      loanOutstandingMinor: 5_000_000,
    });
    expect(s.proRataMinor).toBe(15_000_000); // 15/30 × 300k
    expect(s.leavePayoutMinor).toBe(6_000_000); // 6 × (300k/30)
    expect(s.grossMinor).toBe(21_000_000);
    expect(s.loanRecoveredMinor).toBe(5_000_000);
    expect(s.loanUnrecoveredMinor).toBe(0);
    expect(s.netMinor).toBe(16_000_000);
  });
  it("clamps loan recovery at the gross (net never negative; residue reported)", () => {
    const s = computeFinalSettlement({
      baseMinor: 10_000_000,
      lastWorkingDay: "2026-02-28", // 28/28 of Feb
      leaveDaysRemaining: 0,
      loanOutstandingMinor: 99_000_000,
    });
    expect(s.grossMinor).toBe(10_000_000);
    expect(s.loanRecoveredMinor).toBe(10_000_000);
    expect(s.loanUnrecoveredMinor).toBe(89_000_000);
    expect(s.netMinor).toBe(0);
  });
});

describe("payroll refuses a country whose tax law we do not implement", () => {
  it("REFUSES rather than applying Nigerian PAYE to a foreign salary", async () => {
    // The safe failure. A payslip is handed to an employee and to a revenue
    // authority; being confidently wrong about tax is worse than being unavailable.
    const { service } = makeService({ country: "GB", payrollPack: null });
    await expect(
      service.createRun({ schoolId: "s1", userId: "u1", roles: ["hr_manager"], permissions: [] } as never, 2026, 1),
    ).rejects.toThrow(/not available for GB/i);
  });

  it("turns a pack's REFUSAL into a legible 400, not a 500", async () => {
    // The UK pack refuses a period whose tax year it has no rates for. That must
    // reach the bursar as an explanation of what to do — "internal server error"
    // sends them to support instead of to whoever updates the rates.
    const { service } = makeService({
      country: "GB",
      payrollPack: "GB",
      employees: [{ userId: "u1", salaryEnc: null, status: "ACTIVE" }],
    });
    await expect(
      service.createRun({ schoolId: "s1", userId: "u1", roles: ["hr_manager"], permissions: [] } as never, 2099, 6),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("still runs for a country that HAS a pack", async () => {
    const { service } = makeService({ employees: [] });
    await expect(
      service.createRun({ schoolId: "s1", userId: "u1", roles: ["hr_manager"], permissions: [] } as never, 2026, 1),
    ).resolves.toBeDefined();
  });
});

// =============================================================================
// The bank file is a payment instruction
// =============================================================================
// Finalizing is maker-checker (creator !== finalizer) so one person cannot pay
// the staff alone. Handing out the bank file for a DRAFT run bypassed that
// second signature completely — verified live: 14 rows of names, banks,
// account numbers and net pay from an unfinalized run.
//
// The remittance CSVs in the same service were already gated this way, which is
// what makes this an oversight rather than a decision.

describe("bank export is finalized-only", () => {
  function exportHarness(status: string) {
    const tx = {
      payrollRun: { findFirst: jest.fn().mockResolvedValue({ id: "r1", status, periodMonth: 5, periodYear: 2027 }) },
      payslip: { findMany: jest.fn().mockResolvedValue([{ userId: "u1", netMinor: 100000 }]) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: "u1", name: "Staff" }]) },
      employee: { findMany: jest.fn().mockResolvedValue([{ userId: "u1", bankNameEnc: null, bankAccountEnc: null }]) },
    } as unknown as TenantTx;
    const db = { runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    return {
      svc: new PayrollService(
        db as never,
        { record: jest.fn().mockResolvedValue(undefined) } as never,
        { forSchool: jest.fn().mockResolvedValue({ currency: "NGN" }) } as never,
      ),
      tx,
    };
  }

  const actor = { userId: "hr1", schoolId: "s1", roles: ["hr_manager"], permissions: [] } as unknown as Principal;

  it("refuses a DRAFT run, and says why", async () => {
    const h = exportHarness("DRAFT");
    await expect(h.svc.bankExport(actor, "r1")).rejects.toThrow(/approved by a second person/);
    // Nothing was read: the refusal comes before any payslip or bank detail.
    expect(h.tx.payslip.findMany).not.toHaveBeenCalled();
  });

  it("allows a FINALIZED run", async () => {
    const h = exportHarness("FINALIZED");
    await expect(h.svc.bankExport(actor, "r1")).resolves.toHaveProperty("csv");
  });
});
