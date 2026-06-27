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

function makeService(over: {
  dup?: Record<string, unknown> | null;
  employees?: Array<Record<string, unknown>>;
  run?: Record<string, unknown> | null;
} = {}) {
  const payslipCreate = jest.fn().mockResolvedValue({});
  const runUpdate = jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "run1", periodYear: 2026, periodMonth: 1, status: "DRAFT", totalGrossMinor: 0, totalNetMinor: 0, createdAt: new Date(), finalizedAt: null, ...args.data }));
  const tx = {
    payrollRun: {
      findFirst: jest.fn().mockResolvedValue(over.run ?? over.dup ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "run1", periodYear: 2026, periodMonth: 1, status: "DRAFT", totalGrossMinor: 0, totalNetMinor: 0, createdAt: new Date(), finalizedAt: null }),
      update: runUpdate,
    },
    payslip: { create: payslipCreate, findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    employee: { findMany: jest.fn().mockResolvedValue(over.employees ?? []) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new PayrollService(db as never, audit as never), payslipCreate, runUpdate };
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
    await ok.service.finalizeRun(p("hr2"), "run1");
    expect(ok.runUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FINALIZED", finalizedById: "hr2" }) }));
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
