// =============================================================================
// Mobile money — the rail most African school fees actually travel on
// =============================================================================
// Paystack and Stripe are card and bank rails. In Kenya, Ghana, Uganda, Tanzania,
// Rwanda and francophone West Africa, school fees are paid from a phone: M-Pesa,
// MTN MoMo, Airtel Money. A platform without them is asking most of a continent to
// pay by a method it does not use.
//
// BUILT SO IT DOES NOT ROT. The failure mode for a payments integration over years
// is that every new provider or country adds another branch in six files, until
// nobody can say what happens in Cameroon without reading all six. So:
//
//   • one PROVIDER INTERFACE that every rail implements;
//   • a data-driven COVERAGE table — adding MTN Uganda is a row, not a branch;
//   • callers ask for "a provider for this school" and never name one;
//   • a provider with no credentials is DISABLED, not half-working;
//   • no country covered ⇒ REFUSED, never silently fallen back to card.
// =============================================================================

/** The rails. Adding one is an entry here plus an adapter — nothing else. */
export const MOBILE_MONEY_PROVIDERS = {
  MPESA: "MPESA",
  MTN_MOMO: "MTN_MOMO",
  AIRTEL: "AIRTEL",
} as const;
export type MobileMoneyProviderKey =
  (typeof MOBILE_MONEY_PROVIDERS)[keyof typeof MOBILE_MONEY_PROVIDERS];

/** Where a rail operates, and in what. One row per country a provider serves. */
export interface MobileMoneyCoverage {
  provider: MobileMoneyProviderKey;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** ISO 4217 the rail settles in for that country. */
  currency: string;
  /** International dialling code, used to normalise a local number. */
  dialCode: string;
  /** Human label for the payer ("Pay with M-Pesa"). */
  label: string;
}

/**
 * The coverage table.
 *
 * DELIBERATELY DATA. A new market is a row here; no service, controller or test
 * changes shape. It is also the single place that answers "can this school take
 * mobile money", so the answer cannot differ between the checkout page and the
 * API that refuses it.
 */
export const MOBILE_MONEY_COVERAGE: MobileMoneyCoverage[] = [
  { provider: "MPESA", country: "KE", currency: "KES", dialCode: "254", label: "M-Pesa" },
  { provider: "MPESA", country: "TZ", currency: "TZS", dialCode: "255", label: "M-Pesa" },
  { provider: "MTN_MOMO", country: "GH", currency: "GHS", dialCode: "233", label: "MTN Mobile Money" },
  { provider: "MTN_MOMO", country: "UG", currency: "UGX", dialCode: "256", label: "MTN Mobile Money" },
  { provider: "MTN_MOMO", country: "CM", currency: "XAF", dialCode: "237", label: "MTN Mobile Money" },
  { provider: "MTN_MOMO", country: "CI", currency: "XOF", dialCode: "225", label: "MTN Mobile Money" },
  { provider: "MTN_MOMO", country: "RW", currency: "RWF", dialCode: "250", label: "MTN Mobile Money" },
  { provider: "MTN_MOMO", country: "ZM", currency: "ZMW", dialCode: "260", label: "MTN Mobile Money" },
  { provider: "AIRTEL", country: "KE", currency: "KES", dialCode: "254", label: "Airtel Money" },
  { provider: "AIRTEL", country: "UG", currency: "UGX", dialCode: "256", label: "Airtel Money" },
  { provider: "AIRTEL", country: "TZ", currency: "TZS", dialCode: "255", label: "Airtel Money" },
];

/** Every rail available in a country, in preference order. */
export function coverageFor(country: string): MobileMoneyCoverage[] {
  return MOBILE_MONEY_COVERAGE.filter((c) => c.country === country.toUpperCase());
}

/** Is mobile money possible at all in this country? */
export function hasMobileMoney(country: string): boolean {
  return coverageFor(country).length > 0;
}

export function coverageOf(provider: string, country: string): MobileMoneyCoverage | null {
  return (
    MOBILE_MONEY_COVERAGE.find(
      (c) => c.provider === provider.toUpperCase() && c.country === country.toUpperCase(),
    ) ?? null
  );
}

/**
 * Normalise a payer's phone to the MSISDN these APIs expect: country code, then
 * the subscriber number, no plus and no leading zero.
 *
 * Every one of these rails rejects a number in the wrong shape, and a parent types
 * whichever shape their phone shows them — `0712…`, `+254712…`, `254712…`. Doing
 * this once, here, is why no adapter has to.
 */
export function normaliseMsisdn(raw: string, dialCode: string): string | null {
  const digits = (raw ?? "").replace(/[^\d]/g, "");
  if (!digits) return null;
  // Already international.
  if (digits.startsWith(dialCode)) {
    const rest = digits.slice(dialCode.length);
    return rest.length >= 6 ? digits : null;
  }
  // Local form with a trunk zero.
  const local = digits.replace(/^0+/, "");
  if (local.length < 6) return null;
  return `${dialCode}${local}`;
}

/** A payer-facing option on the checkout screen. */
export interface MobileMoneyOptionDto {
  provider: MobileMoneyProviderKey;
  label: string;
  currency: string;
  dialCode: string;
  /** False when the platform has no credentials for this rail — shown as
   *  unavailable rather than hidden, so a school can see what it could enable. */
  enabled: boolean;
}

/** What a charge request produced. Mobile money is ASYNCHRONOUS: the payer
 *  approves on their handset, so this is an acknowledgement, never a receipt. */
export interface MobileMoneyChargeDto {
  reference: string;
  provider: MobileMoneyProviderKey;
  status: "PENDING";
  /** What to tell the payer to do next, in their own terms. */
  instruction: string;
}
