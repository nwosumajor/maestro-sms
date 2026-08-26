import { computeUkPayslip, latestUkTaxYear, ukTaxYearFor } from "./payroll-uk";
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
  /** National Insurance (UK) or the country's equivalent social contribution.
   *  Absent where a country has none as a separate line — Nigeria folds its
   *  contribution into `pensionMinor`. Included in `deductionsMinor` either way,
   *  so net pay is right whether or not a caller knows about this field. */
  niMinor?: number;
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

/**
 * Statutory payroll is COUNTRY LAW, not configuration.
 *
 * This file implements Nigeria: PIT bands, the Consolidated Relief Allowance, and
 * the 8% pension contribution. None of it is right for Ghana, the UK, the UAE or
 * anywhere else, and a payslip that is confidently wrong about tax is worse than
 * no payslip — it is a filing a school hands to an employee and to a revenue
 * authority.
 *
 * So a country either has a PACK here or payroll REFUSES to run for it. Refusing
 * is the safe failure; computing Nigerian PAYE for a British teacher is not.
 */
export const PAYROLL_PACKS: Record<string, PayrollPack> = {
  NG: {
    key: "NG",
    label: "Nigeria — PAYE (PIT) + 8% pension",
    // Nigeria's bands have been stable across the period this platform has run,
    // so this pack takes no period. If they change, it grows a tax-year table the
    // way the UK pack has one — the interface already allows for it.
    compute: (gross) => computeNigerianPayslip(gross),
  },
  GB: {
    key: "GB",
    label: "United Kingdom — PAYE, National Insurance, auto-enrolment",
    compute: (gross, period) => {
      // UK thresholds change every 6 April. The year comes from the period being
      // PAID, so re-running an old month uses that month's rules, and a period we
      // have no bands for is REFUSED rather than computed with the nearest year.
      const at = period ?? new Date();
      const year = ukTaxYearFor(at);
      if (!year) {
        throw new Error(
          `No UK tax-year rates for ${at.toISOString().slice(0, 10)}. ` +
            `The latest year loaded is ${latestUkTaxYear().year}; add the new thresholds to UK_TAX_YEARS before running payroll for this period. ` +
            `Payroll is unavailable rather than computed with the previous year's figures.`,
        );
      }
      return computeUkPayslip(gross, year);
    },
  },
};

/** Is statutory payroll implemented for this country's pack? */
export function hasPayrollPack(packKey: string | null | undefined): boolean {
  return !!packKey && packKey in PAYROLL_PACKS;
}

/**
 * A country's statutory rules.
 *
 * `period` is the month being PAID, not today: re-running an old month must use
 * that month's rules, and a country whose thresholds move annually needs it to
 * pick the right year at all.
 */
export interface PayrollPack {
  key: string;
  label: string;
  compute: (grossMonthlyMinor: number, period?: Date) => PayslipBreakdown;
}

/**
 * Compute a monthly payslip using the given country pack.
 *
 * `packKey` comes from the school's region. Defaults to Nigeria so every existing
 * caller and every school already live behaves exactly as before.
 */
export function computeMonthlyPayslip(
  grossMonthlyMinor: number,
  packKey = "NG",
  period?: Date,
): PayslipBreakdown {
  const pack = PAYROLL_PACKS[packKey];
  if (!pack) {
    // Never silently substitute another country's tax law.
    throw new Error(
      `No statutory payroll pack for "${packKey}". Payroll is unavailable for this country until one is implemented.`,
    );
  }
  return pack.compute(grossMonthlyMinor, period);
}

/** Nigeria: PIT bands + Consolidated Relief Allowance + 8% pension. */
function computeNigerianPayslip(grossMonthlyMinor: number): PayslipBreakdown {
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
  /** National Insurance or equivalent, where the country has one as a separate
   *  line. Included in `deductionsMinor` regardless. */
  niMinor?: number;
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
export function computeBonusPayslip(baseMinor: number, percent: number, payrollPack = "NG", period?: Date): FullPayslipBreakdown {
  const pct = Math.min(1000, Math.max(0, Math.round(percent)));
  const gross = Math.round((Math.max(0, Math.round(baseMinor)) * pct) / 100);
  const statutory = computeMonthlyPayslip(gross, payrollPack, period);
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
  /** Statutory pack for the school's country. Defaults to Nigeria so every
   *  existing caller behaves exactly as before; an unsupported country throws
   *  rather than borrowing another country's tax law. */
  payrollPack?: string;
  /** The month being PAID. Needed by any country whose thresholds move annually:
   *  re-running an old period must use that period's rules, not this year's. */
  period?: Date;
}): FullPayslipBreakdown {
  const base = Math.max(0, Math.round(input.baseMinor));
  const allowances = (input.allowances ?? [])
    .map((a) => ({ name: a.name, amountMinor: Math.max(0, Math.round(a.amountMinor)) }))
    .filter((a) => a.amountMinor > 0);
  const otherDeductions = (input.otherDeductions ?? [])
    .map((d) => ({ name: d.name, amountMinor: Math.max(0, Math.round(d.amountMinor)) }))
    .filter((d) => d.amountMinor > 0);
  const gross = base + allowances.reduce((s, a) => s + a.amountMinor, 0);
  const statutory = computeMonthlyPayslip(gross, input.payrollPack ?? "NG", input.period);
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
    ...(statutory.niMinor ? { niMinor: statutory.niMinor } : {}),
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
  /** Days worked in the final month / days in that month × monthly basic.
   *  ZERO when that month's payroll has already been paid — see
   *  `finalMonthAlreadyPaid`. */
  proRataMinor: number;
  /**
   * Whether the final month had ALREADY been paid when this was computed.
   *
   * // GOTCHA: this used to be assumed false and never asked. A school that
   * runs payroll on the 25th — which is most of them — paid a member of staff
   * leaving on the 28th their FULL monthly salary through payroll and then a
   * 28/31 pro-rata again in the settlement: on ₦300,000 a month that is
   * ₦270,967.74 of a second payment for a month already discharged, about 90%
   * over. The arithmetic was right for the case where payroll had not run and
   * silently doubled for the case where it had, with nothing distinguishing
   * them.
   *
   * Carried on the settlement rather than only applied, because the figure is
   * SNAPSHOTTED encrypted onto the exit record and an approver reading "pro
   * rata: 0.00" needs to know it means "already paid" and not "worked no days".
   */
  finalMonthAlreadyPaid: boolean;
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
  /**
   * Has a FINALIZED MONTHLY payroll run for the final month already produced a
   * payslip for this person? REQUIRED, deliberately: a required parameter is a
   * search for every caller that was relying on the old assumption — the same
   * trick that found the Paystack currency sites and the payment-approval
   * threshold ones.
   */
  finalMonthAlreadyPaid: boolean;
}): FinalSettlement {
  const base = Math.max(0, Math.round(input.baseMinor));
  const d = new Date(`${input.lastWorkingDay}T00:00:00.000Z`);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  // Nothing further is owed for a month the school has already paid in full.
  // Leave payout and loan recovery still apply — those are not month-bound.
  const proRataMinor = input.finalMonthAlreadyPaid ? 0 : Math.round((base * d.getUTCDate()) / daysInMonth);
  const leaveDaysRemaining = Math.max(0, input.leaveDaysRemaining);
  const leavePayoutMinor = Math.round((base / 30) * leaveDaysRemaining);
  const grossMinor = proRataMinor + leavePayoutMinor;
  const loanOutstandingMinor = Math.max(0, Math.round(input.loanOutstandingMinor));
  const loanRecoveredMinor = Math.min(loanOutstandingMinor, grossMinor);
  return {
    proRataMinor,
    finalMonthAlreadyPaid: input.finalMonthAlreadyPaid,
    leaveDaysRemaining,
    leavePayoutMinor,
    grossMinor,
    loanOutstandingMinor,
    loanRecoveredMinor,
    loanUnrecoveredMinor: loanOutstandingMinor - loanRecoveredMinor,
    netMinor: grossMinor - loanRecoveredMinor,
  };
}
