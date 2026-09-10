// =============================================================================
// Thirty-six payslips, and no way to tell one from another
// =============================================================================
// `GET /hr/me/export` is the NDPR self-service data bundle: what this platform
// holds about a member of staff, handed to them on request. Its payslip section
// returned `{grossMinor, netMinor}` and nothing else.
//
// Driven on three years of payroll: a member of staff got THIRTY-SIX
// indistinguishable objects — two figures each, no period, no date, no run.
// They cannot tell which month any figure belongs to, cannot check one month
// against a payslip they hold, and cannot use the export as evidence of
// anything, which is the whole purpose of an access request.
//
// The sibling read of the same rows — `PayrollService.myPayslips`, behind the
// staff self-service screen — has carried the period all along. One of the two
// was written carefully and the other reduced to its numbers.
//
// Also fixed here, on the same line: DEDUCTIONS. They are on the row already and
// they are the part of a payslip somebody actually queries — tax, pension, a
// loan repayment. Showing gross and net and omitting the difference invites the
// question the export exists to answer.
// =============================================================================

import { HrService } from "../../src/hr/hr.service";
import { encryptField } from "../../src/foundation/field-crypto";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const SCHOOL = "school-a";
const staff: Principal = { schoolId: SCHOOL, userId: "me", roles: ["teacher"], permissions: ["hr.self"] };

type Run = {
  id: string;
  periodYear: number;
  periodMonth: number;
  status: string;
  finalizedAt: Date | null;
  runType: string;
};

function makeService(runs: Run[]) {
  const slips = runs.map((r, i) => ({
    id: `slip-${i}`,
    payrollRunId: r.id,
    userId: "me",
    grossEnc: encryptField(String(300000_00 + i), SCHOOL),
    deductionsEnc: encryptField(String(56526_67 + i), SCHOOL),
    netEnc: encryptField(String(243473_33 + i), SCHOOL),
  }));
  const tx = {
    employee: {
      findFirst: jest.fn(async () => ({
        id: "e1", userId: "me", jobTitle: "Teacher", department: "Academics",
        employmentType: "FULL_TIME", startDate: new Date("2023-09-01"), status: "ACTIVE", salaryEnc: null,
      })),
    },
    leaveRequest: { findMany: jest.fn(async () => []) },
    leaveBalance: { findMany: jest.fn(async () => []) },
    appraisal: { findMany: jest.fn(async () => []) },
    trainingRecord: { findMany: jest.fn(async () => []) },
    staffDocument: { findMany: jest.fn(async () => []) },
    payslip: { findMany: jest.fn(async () => slips) },
    // Honours the `in` it is given: a double that returned every run would hide
    // a service that had stopped joining them to the caller's own payslips.
    payrollRun: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        runs.filter((r) => where.id.in.includes(r.id)),
      ),
    },
  } as unknown as TenantTx;
  const svc = new HrService(
    { runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) } as never,
    { record: jest.fn() } as never,
  );
  return { svc, tx };
}

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1", periodYear: 2026, periodMonth: 9, status: "FINALIZED",
  finalizedAt: new Date("2026-09-28"), runType: "REGULAR", ...over,
});

type Exported = {
  payslips: Array<{
    periodYear: number | null;
    periodMonth: number | null;
    runType: string | null;
    status: string | null;
    finalizedAt: Date | null;
    grossMinor: number | null;
    deductionsMinor: number | null;
    netMinor: number | null;
  }>;
};

describe("the payslips in a staff member's own data export", () => {
  it("SAY WHICH MONTH each one is for", async () => {
    const { svc } = makeService([
      run({ id: "r1", periodMonth: 9 }),
      run({ id: "r2", periodMonth: 8 }),
      run({ id: "r3", periodMonth: 7 }),
    ]);
    const out = (await svc.exportMyData(staff)) as unknown as Exported;
    expect(out.payslips.map((s) => `${s.periodYear}-${s.periodMonth}`)).toEqual(["2026-9", "2026-8", "2026-7"]);
  });

  it("carries the DEDUCTIONS, not just the two ends of them", async () => {
    const { svc } = makeService([run()]);
    const out = (await svc.exportMyData(staff)) as unknown as Exported;
    expect(out.payslips[0]).toMatchObject({
      grossMinor: 30000000,
      deductionsMinor: 5652667,
      netMinor: 24347333,
    });
    // And the figures are the DECRYPTED ones, not the ciphertext.
    expect(out.payslips[0].grossMinor).toBe(out.payslips[0].netMinor! + out.payslips[0].deductionsMinor!);
  });

  it("reads newest first, the order a person reads their own pay history in", async () => {
    const { svc } = makeService([
      run({ id: "r1", periodYear: 2025, periodMonth: 12 }),
      run({ id: "r2", periodYear: 2026, periodMonth: 1 }),
      run({ id: "r3", periodYear: 2024, periodMonth: 6 }),
    ]);
    const out = (await svc.exportMyData(staff)) as unknown as Exported;
    expect(out.payslips.map((s) => `${s.periodYear}-${String(s.periodMonth).padStart(2, "0")}`)).toEqual([
      "2026-01",
      "2025-12",
      "2024-06",
    ]);
  });

  it("LABELS a draft rather than dropping it — an export omits nothing in silence", async () => {
    // A draft is not yet a payment, and saying so beats leaving a gap in a
    // sequence of months that the reader will notice and cannot explain.
    const { svc } = makeService([run({ id: "r1", periodMonth: 9 }), run({ id: "r2", periodMonth: 8, status: "DRAFT", finalizedAt: null })]);
    const out = (await svc.exportMyData(staff)) as unknown as Exported;
    expect(out.payslips).toHaveLength(2);
    expect(out.payslips.map((s) => s.status)).toEqual(["FINALIZED", "DRAFT"]);
    expect(out.payslips.find((s) => s.status === "DRAFT")!.finalizedAt).toBeNull();
  });

  it("names the KIND of run, so a bonus is not read as a month's pay", async () => {
    const { svc } = makeService([run({ id: "r1", periodMonth: 12, runType: "THIRTEENTH_MONTH" })]);
    const out = (await svc.exportMyData(staff)) as unknown as Exported;
    expect(out.payslips[0].runType).toBe("THIRTEENTH_MONTH");
  });

  it("asks for the runs ONCE, not once per payslip", async () => {
    // Three years is thirty-six rows; a lookup per row is a query multiplier
    // over a table that grows by one per person per month for ever.
    const { svc, tx } = makeService(Array.from({ length: 36 }, (_, i) => run({ id: `r${i}`, periodMonth: (i % 12) + 1 })));
    await svc.exportMyData(staff);
    expect((tx as unknown as { payrollRun: { findMany: jest.Mock } }).payrollRun.findMany).toHaveBeenCalledTimes(1);
  });
});
