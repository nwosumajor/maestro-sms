// =============================================================================
// Currency — how many minor units a currency actually has
// =============================================================================
// The platform stores money as integer MINOR units and divided by 100 everywhere.
// That is right for the naira, the cedi, the shilling, the rand, the pound and the
// dollar — and WRONG for a large part of Africa.
//
// The CFA franc has no centime. So does the Rwandan and Ugandan shilling, the
// Burundian and Djiboutian franc, the Guinean franc and the Comorian franc:
//
//     stored 150000    NGN -> ₦1,500.00      correct
//     stored 150000    XOF -> F CFA 1,500    WRONG — it is 150,000
//
// That is the whole franc zone — 8 UEMOA countries and 6 CEMAC — plus six others:
// roughly twenty African countries where every fee, invoice and payslip would have
// been out by a factor of a hundred, and where a gateway would have been asked to
// charge a hundredth of the intended amount.
//
// `minorUnits(currency)` is the single answer, and it is derived from Intl rather
// than a hand-kept list, so a currency nobody thought about still gets the right
// answer from the platform's own ICU data.
// =============================================================================

/**
 * Currencies the PLATFORM can express for its own billing.
 *
 * TWO DIFFERENT QUESTIONS, and conflating them is how a broken checkout gets
 * shipped:
 *   • what a school may CHARGE ITS PARENTS in — any ISO code, its own business,
 *     stored on `school.currency` as a plain string and formatted by this module;
 *   • what it may PAY THE PLATFORM in — this list, which needs a price list and a
 *     settlement rail behind each entry.
 *
 * Paystack settles NGN/GHS/ZAR/KES and Stripe USD/GBP/EUR, so those are expressible
 * here. Only the ones with PRICING are actually offered at checkout — see
 * `planCurrencies`. Adding a market is a price list, not a code change.
 */
export const CURRENCIES = {
  NGN: "NGN",
  USD: "USD",
  GHS: "GHS",
  KES: "KES",
  ZAR: "ZAR",
  GBP: "GBP",
  EUR: "EUR",
} as const;
export type Currency = (typeof CURRENCIES)[keyof typeof CURRENCIES];
export function isCurrency(v: unknown): v is Currency {
  return typeof v === "string" && v in CURRENCIES;
}

/**
 * How many decimal places this currency has.
 *
 * Asked of the runtime's own ICU data rather than a list we maintain: a hand-kept
 * table is exactly the thing that goes stale, and getting it wrong is a 100×
 * error in someone's fees. Falls back to 2 — the overwhelming majority — if a
 * currency code is unknown to the runtime.
 */
export function currencyDecimals(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Minor units per major unit: 100 for the naira, 1 for the CFA franc. */
export function minorUnits(currency: string): number {
  return 10 ** currencyDecimals(currency);
}

/** True when a currency has no subdivision — the case the old `/ 100` broke. */
export function isZeroDecimal(currency: string): boolean {
  return currencyDecimals(currency) === 0;
}

/** Integer minor units -> the major amount, for display or for a gateway that
 *  wants majors. NEVER divide by 100 directly. */
export function toMajor(amountMinor: number, currency: string): number {
  return (amountMinor ?? 0) / minorUnits(currency);
}

/** A major amount typed by a person -> integer minor units for storage.
 *  Rounds, because a fractional minor unit cannot be stored or charged. */
export function toMinor(amountMajor: number, currency: string): number {
  return Math.round((amountMajor ?? 0) * minorUnits(currency));
}

/**
 * Format money held as integer minor units.
 *
 * The one function every surface should use. It divides by the currency's OWN
 * scale, so 150000 is ₦1,500.00 and F CFA 150,000 — both correct, from the same
 * stored integer.
 */
export function formatMoney(amountMinor: number, currency: string, locale = "en"): string {
  const major = toMajor(amountMinor, currency);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(major);
  } catch {
    // An unknown currency or locale must still render a number, never blank.
    return `${currency} ${major.toFixed(currencyDecimals(currency))}`;
  }
}

// =============================================================================
// What each CARD rail can actually settle
// =============================================================================
// A gateway charges in ITS OWN account currency when you do not name one. That is
// not a rounding error: a Ghanaian school raising a GHS 5,000 invoice had the
// parent charged NGN 5,000 — about a tenth of the value — while the ledger
// recorded the invoice as settled. The school is underpaid and nothing says so.
//
// So the currency is always sent EXPLICITLY, and a currency a rail cannot settle
// is REFUSED rather than silently charged in the wrong one. Same posture as the
// payroll packs and plan pricing: refuse, never approximate.
// =============================================================================

/** Currencies Paystack can settle. An account is additionally enabled per
 *  currency, so this is the ceiling, not a guarantee. */
export const PAYSTACK_CURRENCIES = ["NGN", "GHS", "ZAR", "KES", "USD"] as const;

/** Stripe settles far more, but the platform only raises USD on it today. */
export const STRIPE_CURRENCIES = ["USD"] as const;

export function paystackCanSettle(currency: string): boolean {
  return (PAYSTACK_CURRENCIES as readonly string[]).includes(currency.toUpperCase());
}

/**
 * Stripe's zero-decimal currencies: the amount is in the MAJOR unit, not cents.
 * Sending 500000 for JPY 5,000 charges a hundred times too much. The platform is
 * USD-only on Stripe today, so this exists to make the next currency safe rather
 * than to fix a live bug — `toMinor`/`minorUnits` already model this correctly for
 * the rest of the platform, and a rail must not disagree with them.
 */
export const STRIPE_ZERO_DECIMAL = [
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG",
  "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
] as const;

export function stripeAmountFor(amountMinor: number, currency: string): number {
  return (STRIPE_ZERO_DECIMAL as readonly string[]).includes(currency.toUpperCase())
    ? toMajor(amountMinor, currency)
    : amountMinor;
}
