// =============================================================================
// Payroll computation — pure, testable. Nigerian PAYE (PIT) + pension.
// =============================================================================
// All amounts are integer MINOR units (kobo). `salaryMinor` is treated as the
// MONTHLY gross. PAYE follows the Personal Income Tax bands on annual taxable pay
// (gross − pension relief − Consolidated Relief Allowance), pension is the 8%
// employee contribution. Deliberately a clean approximation (no NHF/other reliefs)
// — the single source of truth so web, API, and payslip PDF agree to the kobo.
// =============================================================================

export interface PayslipBreakdown {
  grossMinor: number;
  pensionMinor: number;
  payeMinor: number;
  deductionsMinor: number;
  netMinor: number;
}

// Annual PIT bands: [band width in minor units, rate]. Last band is open-ended.
const PIT_BANDS: Array<[number, number]> = [
  [300_000_00, 0.07],
  [300_000_00, 0.11],
  [500_000_00, 0.15],
  [500_000_00, 0.19],
  [1_600_000_00, 0.21],
  [Number.POSITIVE_INFINITY, 0.24],
];

/** Compute a monthly payslip breakdown from the monthly gross (minor units). */
export function computeMonthlyPayslip(grossMonthlyMinor: number): PayslipBreakdown {
  const gross = Math.max(0, Math.round(grossMonthlyMinor));
  const grossAnnual = gross * 12;
  const pensionAnnual = Math.round(grossAnnual * 0.08);
  // Consolidated Relief Allowance: higher of ₦200k or 1% of gross, plus 20% of gross.
  const cra = Math.max(200_000_00, Math.round(grossAnnual * 0.01)) + Math.round(grossAnnual * 0.2);
  let taxable = Math.max(0, grossAnnual - pensionAnnual - cra);
  let payeAnnual = 0;
  for (const [width, rate] of PIT_BANDS) {
    if (taxable <= 0) break;
    const slice = Math.min(taxable, width);
    payeAnnual += slice * rate;
    taxable -= slice;
  }
  const pensionMinor = Math.round(pensionAnnual / 12);
  const payeMinor = Math.round(payeAnnual / 12);
  const deductionsMinor = pensionMinor + payeMinor;
  return { grossMinor: gross, pensionMinor, payeMinor, deductionsMinor, netMinor: gross - deductionsMinor };
}
