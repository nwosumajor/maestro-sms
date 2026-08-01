// =============================================================================
// UK statutory payroll — PAYE income tax, National Insurance, auto-enrolment
// =============================================================================
// WHY THIS FILE IS SHAPED LIKE THIS, and not like the Nigerian pack next to it:
//
// UK thresholds change EVERY tax year, on 6 April. A pack that hard-codes one
// year's numbers is not "done" — it is a bug with a start date. So the bands are
// keyed by TAX YEAR, the year is chosen from the period being PAID, and a period
// whose year we have no bands for is REFUSED rather than computed with the nearest
// year's figures.
//
// That refusal is the whole design. The failure modes for payroll are asymmetric:
//   • unavailable  — the school notices immediately and rings you;
//   • silently 4% wrong — nobody notices, and it is wrong on every payslip and
//     every RTI submission until an employee or HMRC works it out.
// The second is far more expensive, so the code is built to produce the first.
//
// SCOPE, stated plainly so nobody assumes more than is here:
//   • England, Wales and Northern Ireland income tax. SCOTLAND HAS DIFFERENT BANDS
//     and is deliberately NOT implemented — see SCOTTISH_RATES_UNSUPPORTED.
//   • Class 1 employee National Insurance, category A (the ordinary case).
//   • Auto-enrolment pension on qualifying earnings, employee share.
//   • Cumulative-basis approximations: this computes a MONTH in isolation (1/12 of
//     the annual thresholds), which is what a Month-1 / non-cumulative code does.
//     It does not track year-to-date, so it will not replicate HMRC's cumulative
//     calculation to the penny across a year of changing pay.
//
// NOT A SUBSTITUTE FOR PAYROLL SOFTWARE OR ADVICE. These figures must be checked
// against HMRC's published rates for the year before anyone is paid from them.
// =============================================================================

import type { PayslipBreakdown } from "./payroll";

/** One tax year's thresholds. All amounts are ANNUAL, in integer minor units
 *  (pence), so the arithmetic matches the rest of the platform. */
export interface UkTaxYear {
  /** HMRC style, e.g. "2025-26". */
  year: string;
  /** First day of the tax year, inclusive (always 6 April). */
  startsOn: string;
  /** Last day, inclusive (always 5 April). */
  endsOn: string;

  // --- income tax (England, Wales, Northern Ireland) --------------------------
  /** Personal allowance before tax is due. */
  personalAllowance: number;
  /** Income above which the allowance tapers by £1 for every £2. */
  taperThreshold: number;
  /** [width of band above the allowance, rate]. Last band is open-ended. */
  bands: Array<[number, number]>;

  // --- National Insurance (Class 1 employee, category A) ----------------------
  /** Earnings above this attract NI. */
  primaryThreshold: number;
  /** Above this, the lower (2%) rate applies. */
  upperEarningsLimit: number;
  mainNiRate: number;
  upperNiRate: number;

  // --- auto-enrolment pension -------------------------------------------------
  /** Qualifying earnings band — contributions apply between these. */
  qualifyingLower: number;
  qualifyingUpper: number;
  /** Employee's share of qualifying earnings. */
  employeeRate: number;
}

/**
 * The tax years this pack knows.
 *
 * ADDING A YEAR IS THE ENTIRE MAINTENANCE TASK: copy the last entry, update the
 * figures from HMRC's rates-and-thresholds page, add it here. Nothing else in the
 * codebase changes, and no historical payslip moves — they are stored breakdowns,
 * not recomputations.
 *
 * `payroll-uk.spec.ts` fails once the CURRENT tax year is missing, so the build
 * tells you before a school does.
 */
export const UK_TAX_YEARS: UkTaxYear[] = [
  {
    year: "2024-25",
    startsOn: "2024-04-06",
    endsOn: "2025-04-05",
    personalAllowance: 12_570_00,
    taperThreshold: 100_000_00,
    bands: [
      [37_700_00, 0.2], // basic
      [87_440_00, 0.4], // higher, to £125,140
      [Number.POSITIVE_INFINITY, 0.45], // additional
    ],
    primaryThreshold: 12_570_00,
    upperEarningsLimit: 50_270_00,
    mainNiRate: 0.08,
    upperNiRate: 0.02,
    qualifyingLower: 6_240_00,
    qualifyingUpper: 50_270_00,
    employeeRate: 0.05,
  },
  {
    year: "2025-26",
    startsOn: "2025-04-06",
    endsOn: "2026-04-05",
    personalAllowance: 12_570_00,
    taperThreshold: 100_000_00,
    bands: [
      [37_700_00, 0.2],
      [87_440_00, 0.4],
      [Number.POSITIVE_INFINITY, 0.45],
    ],
    primaryThreshold: 12_570_00,
    upperEarningsLimit: 50_270_00,
    mainNiRate: 0.08,
    upperNiRate: 0.02,
    qualifyingLower: 6_240_00,
    qualifyingUpper: 50_270_00,
    employeeRate: 0.05,
  },
  {
    // CHECK THESE BEFORE PAYING ANYONE. They follow the announced freeze of income
    // tax and NI thresholds, which holds the personal allowance at £12,570 and the
    // higher-rate threshold at £50,270 — so this year is identical to the last.
    // A freeze is an assumption, not a source: verify against HMRC's
    // rates-and-thresholds page for 2026-27 before a real run.
    year: "2026-27",
    startsOn: "2026-04-06",
    endsOn: "2027-04-05",
    personalAllowance: 12_570_00,
    taperThreshold: 100_000_00,
    bands: [
      [37_700_00, 0.2],
      [87_440_00, 0.4],
      [Number.POSITIVE_INFINITY, 0.45],
    ],
    primaryThreshold: 12_570_00,
    upperEarningsLimit: 50_270_00,
    mainNiRate: 0.08,
    upperNiRate: 0.02,
    qualifyingLower: 6_240_00,
    qualifyingUpper: 50_270_00,
    employeeRate: 0.05,
  },
];

/** Scotland sets its own income-tax bands. Running English bands on a Scottish
 *  employee produces a wrong figure that looks entirely plausible, so it is a
 *  refusal rather than an approximation. */
export const SCOTTISH_RATES_UNSUPPORTED =
  "Scottish income-tax bands are not implemented. A Scottish employee taxed on English bands is silently wrong, so payroll is unavailable rather than approximate.";

/** The tax year containing a date, or null when we have no bands for it. */
export function ukTaxYearFor(date: Date): UkTaxYear | null {
  const iso = date.toISOString().slice(0, 10);
  return UK_TAX_YEARS.find((y) => iso >= y.startsOn && iso <= y.endsOn) ?? null;
}

/** The latest year we hold — used only for messages, never as a fallback. */
export function latestUkTaxYear(): UkTaxYear {
  return UK_TAX_YEARS[UK_TAX_YEARS.length - 1];
}

/** Progressive bands over an amount, from the bottom up. */
function applyBands(taxable: number, bands: Array<[number, number]>): number {
  let left = Math.max(0, taxable);
  let tax = 0;
  for (const [width, rate] of bands) {
    if (left <= 0) break;
    const slice = Math.min(left, width);
    tax += slice * rate;
    left -= slice;
  }
  return tax;
}

/**
 * A UK monthly payslip.
 *
 * Computed from the ANNUALISED gross (month × 12) and then divided back, which is
 * how a non-cumulative code behaves and keeps a steady salary producing an
 * identical figure every month.
 */
export function computeUkPayslip(grossMonthlyMinor: number, taxYear: UkTaxYear): PayslipBreakdown {
  const gross = Math.max(0, Math.round(grossMonthlyMinor));
  const annual = gross * 12;

  // Personal allowance tapers by £1 for every £2 above £100,000, reaching nil at
  // £125,140. Omitting this is the classic UK payroll bug: a £110k salary is taxed
  // as though it kept the full allowance.
  const taper = Math.max(0, Math.floor((annual - taxYear.taperThreshold) / 2));
  const allowance = Math.max(0, taxYear.personalAllowance - taper);
  const payeAnnual = applyBands(annual - allowance, taxYear.bands);

  // National Insurance: banded, not progressive-cumulative — the main rate between
  // the primary threshold and the upper earnings limit, then the lower rate above.
  const niMain = Math.max(0, Math.min(annual, taxYear.upperEarningsLimit) - taxYear.primaryThreshold);
  const niUpper = Math.max(0, annual - taxYear.upperEarningsLimit);
  const niAnnual = niMain * taxYear.mainNiRate + niUpper * taxYear.upperNiRate;

  // Auto-enrolment: the employee's share of QUALIFYING earnings — the slice
  // between the lower and upper limits, not the whole salary.
  const qualifying = Math.max(
    0,
    Math.min(annual, taxYear.qualifyingUpper) - taxYear.qualifyingLower,
  );
  const pensionAnnual = qualifying * taxYear.employeeRate;

  const payeMinor = Math.round(payeAnnual / 12);
  const niMinor = Math.round(niAnnual / 12);
  const pensionMinor = Math.round(pensionAnnual / 12);
  const deductionsMinor = payeMinor + niMinor + pensionMinor;

  return {
    grossMinor: gross,
    payeMinor,
    niMinor,
    pensionMinor,
    deductionsMinor,
    netMinor: gross - deductionsMinor,
  };
}
