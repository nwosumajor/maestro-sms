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

// =============================================================================
// Full payslip — base + allowances, statutory + other deductions + loan recovery
// =============================================================================

/** A named amount line on a payslip (allowance or deduction), integer kobo. */
export interface PayLine {
  name: string;
  amountMinor: number;
}

/** One loan's recovery applied on a payslip. */
export interface LoanInstallmentLine {
  loanId: string;
  installmentMinor: number;
}

/** The COMPLETE per-payslip breakdown, snapshotted (encrypted) onto the payslip
 *  row at run time — payslips render from this, never by recomputing. */
export interface FullPayslipBreakdown {
  baseMinor: number;
  allowances: PayLine[];
  grossMinor: number;
  payeMinor: number;
  pensionMinor: number;
  otherDeductions: PayLine[];
  loans: LoanInstallmentLine[];
  /** Statutory + other + loan recovery. */
  deductionsMinor: number;
  netMinor: number;
}

/**
 * Compute a full monthly payslip. Gross = base + allowances (consolidated —
 * statutory PAYE/pension are computed on the full gross). Deductions apply in
 * order: statutory, then other deductions, then loan recovery — and loan
 * installments are CLAMPED so net never goes below zero (partial recovery; the
 * remainder stays on the loan balance for the next run). Pure and deterministic.
 */
/** Nigerian employer pension contribution (10% of monthly emoluments) — an
 *  employer COST shown on the remittance schedule, never a payslip deduction. */
export function employerPensionMinor(grossMinor: number): number {
  return Math.round(Math.max(0, grossMinor) * 0.1);
}

/**
 * A 13th-month / bonus payslip: `percent` of the BASIC salary (13th month =
 * 100). Taxable income, so PAYE applies (approximated as a regular month at
 * that gross); pension is NOT deducted (it applies to monthly emoluments),
 * and no components/loans touch a bonus. Pure.
 */
export function computeBonusPayslip(baseMinor: number, percent: number): FullPayslipBreakdown {
  const pct = Math.min(1000, Math.max(0, Math.round(percent)));
  const gross = Math.round((Math.max(0, Math.round(baseMinor)) * pct) / 100);
  const statutory = computeMonthlyPayslip(gross);
  return {
    baseMinor: gross,
    allowances: [],
    grossMinor: gross,
    payeMinor: statutory.payeMinor,
    pensionMinor: 0,
    otherDeductions: [],
    loans: [],
    deductionsMinor: statutory.payeMinor,
    netMinor: gross - statutory.payeMinor,
  };
}

export function computeFullPayslip(input: {
  baseMinor: number;
  allowances?: PayLine[];
  otherDeductions?: PayLine[];
  /** Requested recovery per loan this month (already capped at loan balance). */
  loanInstallments?: LoanInstallmentLine[];
}): FullPayslipBreakdown {
  const base = Math.max(0, Math.round(input.baseMinor));
  const allowances = (input.allowances ?? [])
    .map((a) => ({ name: a.name, amountMinor: Math.max(0, Math.round(a.amountMinor)) }))
    .filter((a) => a.amountMinor > 0);
  const otherDeductions = (input.otherDeductions ?? [])
    .map((d) => ({ name: d.name, amountMinor: Math.max(0, Math.round(d.amountMinor)) }))
    .filter((d) => d.amountMinor > 0);
  const gross = base + allowances.reduce((s, a) => s + a.amountMinor, 0);
  const statutory = computeMonthlyPayslip(gross);
  const otherTotal = otherDeductions.reduce((s, d) => s + d.amountMinor, 0);
  // Recoverable this month: what's left after statutory + other deductions.
  let available = Math.max(0, gross - statutory.deductionsMinor - otherTotal);
  const loans: LoanInstallmentLine[] = [];
  for (const l of input.loanInstallments ?? []) {
    const want = Math.max(0, Math.round(l.installmentMinor));
    const take = Math.min(want, available);
    if (take > 0) {
      loans.push({ loanId: l.loanId, installmentMinor: take });
      available -= take;
    }
  }
  const loanTotal = loans.reduce((s, l) => s + l.installmentMinor, 0);
  const deductionsMinor = statutory.deductionsMinor + otherTotal + loanTotal;
  return {
    baseMinor: base,
    allowances,
    grossMinor: gross,
    payeMinor: statutory.payeMinor,
    pensionMinor: statutory.pensionMinor,
    otherDeductions,
    loans,
    deductionsMinor,
    netMinor: gross - deductionsMinor,
  };
}

// =============================================================================
// Final settlement — exit management (resignation / termination / retirement)
// =============================================================================

/** The computed exit settlement, snapshotted (encrypted) onto the exit record. */
export interface FinalSettlement {
  /** Days worked in the final month / days in that month × monthly basic. */
  proRataMinor: number;
  leaveDaysRemaining: number;
  /** leaveDaysRemaining × (basic / 30). */
  leavePayoutMinor: number;
  grossMinor: number;
  loanOutstandingMinor: number;
  /** Recovery is clamped at the gross — a bigger loan leaves a residue owed. */
  loanRecoveredMinor: number;
  loanUnrecoveredMinor: number;
  netMinor: number;
}

/**
 * Compute an exit settlement. Pro-rata final-month pay (calendar-day basis) +
 * accrued-leave payout (basic/30 per day), minus outstanding loan balances
 * (clamped so net ≥ 0; any remainder is reported as unrecovered). Pure.
 */
export function computeFinalSettlement(input: {
  baseMinor: number;
  lastWorkingDay: string; // YYYY-MM-DD
  leaveDaysRemaining: number;
  loanOutstandingMinor: number;
}): FinalSettlement {
  const base = Math.max(0, Math.round(input.baseMinor));
  const d = new Date(`${input.lastWorkingDay}T00:00:00.000Z`);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const proRataMinor = Math.round((base * d.getUTCDate()) / daysInMonth);
  const leaveDaysRemaining = Math.max(0, input.leaveDaysRemaining);
  const leavePayoutMinor = Math.round((base / 30) * leaveDaysRemaining);
  const grossMinor = proRataMinor + leavePayoutMinor;
  const loanOutstandingMinor = Math.max(0, Math.round(input.loanOutstandingMinor));
  const loanRecoveredMinor = Math.min(loanOutstandingMinor, grossMinor);
  return {
    proRataMinor,
    leaveDaysRemaining,
    leavePayoutMinor,
    grossMinor,
    loanOutstandingMinor,
    loanRecoveredMinor,
    loanUnrecoveredMinor: loanOutstandingMinor - loanRecoveredMinor,
    netMinor: grossMinor - loanRecoveredMinor,
  };
}
