// =============================================================================
// UK payroll pack — and the machinery that keeps it from silently rotting
// =============================================================================
// A payroll pack is not a feature you finish. UK thresholds move every 6 April, so
// a hard-coded pack is a bug with a start date. The tests here fall into two
// groups, and the second matters more in the long run:
//
//   1. the arithmetic is right for the years we hold;
//   2. the code REFUSES, loudly, the moment it is asked for a year it does not
//      hold — and the build tells us before a school does.
//
// The failure modes are asymmetric. "Payroll is unavailable" gets a phone call the
// same morning. "Payroll is 4% wrong" is discovered by an employee, or by HMRC,
// after it has been wrong on every payslip for months.
// =============================================================================

import {
  PAYROLL_PACKS,
  UK_TAX_YEARS,
  computeMonthlyPayslip,
  computeUkPayslip,
  hasPayrollPack,
  latestUkTaxYear,
  ukTaxYearFor,
} from "@sms/types";

const y2526 = UK_TAX_YEARS.find((y) => y.year === "2025-26")!;
const inYear = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("UK income tax", () => {
  it("takes nothing below the personal allowance", () => {
    // £12,000 a year is under £12,570 — no tax, and NI only on the slice above the
    // primary threshold, which is also nil here.
    const s = computeUkPayslip(Math.round(12_000_00 / 12), y2526);
    expect(s.payeMinor).toBe(0);
    expect(s.niMinor).toBe(0);
  });

  it("taxes a basic-rate salary at 20% of the amount above the allowance", () => {
    // £30,000: (30,000 − 12,570) × 20% = £3,486/yr = £290.50/mo.
    const s = computeUkPayslip(Math.round(30_000_00 / 12), y2526);
    expect(s.payeMinor).toBe(29_050);
  });

  it("reaches the higher rate above the basic band", () => {
    // £60,000: 37,700 @ 20% = 7,540, then (60,000 − 12,570 − 37,700) = 9,730 @ 40%
    // = 3,892. Total 11,432/yr.
    const s = computeUkPayslip(Math.round(60_000_00 / 12), y2526);
    expect(s.payeMinor).toBe(Math.round(11_432_00 / 12));
  });

  it("TAPERS the personal allowance above £100,000", () => {
    // The classic UK payroll bug. £110,000 loses £5,000 of allowance (£1 for every
    // £2 over £100,000), leaving £7,570 — a school running naive bands would
    // under-tax this employee by £2,000 a year.
    const s = computeUkPayslip(Math.round(110_000_00 / 12), y2526);
    const naiveAllowance = 12_570_00;
    const taperedAllowance = 7_570_00;
    expect(taperedAllowance).toBeLessThan(naiveAllowance);
    // 37,700 @ 20% = 7,540; (110,000 − 7,570 − 37,700) = 64,730 @ 40% = 25,892.
    expect(s.payeMinor).toBe(Math.round(33_432_00 / 12));
  });

  it("removes the allowance entirely at £125,140", () => {
    const s = computeUkPayslip(Math.round(125_140_00 / 12), y2526);
    // 37,700 @ 20% = 7,540; the remaining 87,440 @ 40% = 34,976.
    expect(s.payeMinor).toBe(Math.round(42_516_00 / 12));
  });
});

describe("National Insurance", () => {
  it("charges the main rate between the thresholds", () => {
    // £30,000: (30,000 − 12,570) × 8% = £1,394.40/yr.
    const s = computeUkPayslip(Math.round(30_000_00 / 12), y2526);
    expect(s.niMinor).toBe(Math.round(1_394_40 / 12));
  });

  it("drops to the lower rate above the upper earnings limit", () => {
    // £60,000: (50,270 − 12,570) @ 8% = 3,016; (60,000 − 50,270) @ 2% = 194.60.
    const s = computeUkPayslip(Math.round(60_000_00 / 12), y2526);
    expect(s.niMinor).toBe(Math.round(3_210_60 / 12));
  });

  it("is a SEPARATE line from pension, not folded into it", () => {
    // Nigeria has one statutory contribution; the UK has two, and a payslip that
    // merged them would not reconcile against an employee's own records.
    const s = computeUkPayslip(Math.round(30_000_00 / 12), y2526);
    expect(s.niMinor).toBeGreaterThan(0);
    expect(s.pensionMinor).toBeGreaterThan(0);
    expect(s.deductionsMinor).toBe(s.payeMinor + s.niMinor! + s.pensionMinor);
    expect(s.netMinor).toBe(s.grossMinor - s.deductionsMinor);
  });
});

describe("auto-enrolment pension", () => {
  it("charges 5% of QUALIFYING earnings, not of the whole salary", () => {
    // £30,000: qualifying slice is 30,000 − 6,240 = 23,760, at 5% = £1,188/yr.
    // Five per cent of the whole salary would be £1,500 — a quarter too much.
    const s = computeUkPayslip(Math.round(30_000_00 / 12), y2526);
    expect(s.pensionMinor).toBe(Math.round(1_188_00 / 12));
  });

  it("caps qualifying earnings at the upper limit", () => {
    // Above £50,270 the contribution stops growing.
    const high = computeUkPayslip(Math.round(200_000_00 / 12), y2526);
    const atCap = computeUkPayslip(Math.round(50_270_00 / 12), y2526);
    expect(high.pensionMinor).toBe(atCap.pensionMinor);
  });
});

describe("tax-year selection — the part that keeps this correct in five years", () => {
  it("picks the year containing the period being PAID", () => {
    // 6 April is the boundary. A March payslip belongs to the year that is ending,
    // not the one starting — re-running an old month must use that month's rules.
    expect(ukTaxYearFor(inYear("2025-04-05"))!.year).toBe("2024-25");
    expect(ukTaxYearFor(inYear("2025-04-06"))!.year).toBe("2025-26");
    expect(ukTaxYearFor(inYear("2026-04-05"))!.year).toBe("2025-26");
  });

  it("REFUSES a period we have no rates for, rather than using the nearest year", () => {
    // The whole point. When April 2026 arrives and nobody has added the new
    // thresholds, payroll stops with an explanation — it does not quietly bill the
    // previous year's figures, which is the failure nobody notices.
    const beyond = new Date(`${latestUkTaxYear().endsOn}T00:00:00.000Z`);
    beyond.setUTCFullYear(beyond.getUTCFullYear() + 1);
    expect(ukTaxYearFor(beyond)).toBeNull();
    expect(() => computeMonthlyPayslip(3_000_00, "GB", beyond)).toThrow(/No UK tax-year rates/);
  });

  it("names the fix in the error, so nobody has to read this file to act on it", () => {
    const beyond = new Date("2099-06-01T00:00:00.000Z");
    expect(() => computeMonthlyPayslip(3_000_00, "GB", beyond)).toThrow(/add the new thresholds to UK_TAX_YEARS/);
  });

  it("holds rates for the CURRENT tax year", () => {
    // A DELIBERATE early warning. This fails on the first 6 April after the last
    // loaded year ends — in CI, months before a school tries to run payroll and
    // months before HMRC would notice. If you are reading this because it went
    // red: add the new year's thresholds to UK_TAX_YEARS from HMRC's
    // rates-and-thresholds page. That is the entire task.
    const today = new Date();
    const year = ukTaxYearFor(today);
    expect({
      today: today.toISOString().slice(0, 10),
      hasRates: year !== null,
      latestLoaded: latestUkTaxYear().year,
    }).toEqual({ today: today.toISOString().slice(0, 10), hasRates: true, latestLoaded: latestUkTaxYear().year });
  });
});

describe("the pack registry", () => {
  it("declares the UK supported and Nigeria unchanged", () => {
    expect(hasPayrollPack("GB")).toBe(true);
    expect(hasPayrollPack("NG")).toBe(true);
    expect(hasPayrollPack("FR")).toBe(false);
  });

  it("does not disturb the Nigerian pack", () => {
    // The regression that would matter most: a country already running payroll
    // must produce the same figures it produced yesterday.
    const ng = computeMonthlyPayslip(500_000_00, "NG");
    expect(ng.payeMinor).toBeGreaterThan(0);
    expect(ng.niMinor).toBeUndefined(); // Nigeria has no separate NI line
    expect(ng.netMinor).toBe(ng.grossMinor - ng.deductionsMinor);
  });

  it("every pack is self-consistent: net = gross − deductions", () => {
    // Cheap, and it catches a whole class of arithmetic slip in any future pack.
    for (const [key, pack] of Object.entries(PAYROLL_PACKS)) {
      const s = pack.compute(400_000, new Date("2025-09-15T00:00:00.000Z"));
      expect({ key, ok: s.netMinor === s.grossMinor - s.deductionsMinor }).toEqual({ key, ok: true });
      expect({ key, nonNegative: s.netMinor >= 0 }).toEqual({ key, nonNegative: true });
    }
  });
});
