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

/**
 * Money for a PDF — guaranteed to survive the standard-font encoding.
 *
 * // GOTCHA: `formatMoney` returns the SYMBOL, and pdfkit's built-in fonts are
 * WinAnsi — a single byte per character. `₦` is U+20A6, which WinAnsi has no
 * room for, so pdfkit silently wrote its LOW BYTE: 0xA6, the broken bar. Every
 * payslip a Nigerian school handed an employee read **`¦200,000.00`**, and so
 * did every fee receipt a parent was given. Verified by decoding a real
 * payslip's content stream: bytes `20 A6 32 30 30`.
 *
 * It is not only the naira. The CFA franc renders `F CFA` with a NARROW NO-BREAK
 * SPACE (U+202F) in every locale — eleven of the catalogue's African countries —
 * and a French locale uses U+202F as the grouping separator for EVERY currency,
 * so a francophone school's documents broke whatever it billed in.
 *
 * The fix is the ISO CODE plus an ASCII-safe separator, not a symbol: "NGN
 * 200,000.00". Embedding a Unicode font would carry a font file and its licence
 * into every PDF the product prints, to render one glyph. The code is also less
 * ambiguous on a platform that bills several currencies — and the payslip
 * already had to say "Figures in NGN" at the bottom precisely because the symbol
 * could not be trusted.
 *
 * The LOCALE is still honoured for grouping and decimals, so a French school
 * keeps `1 234,50` rather than being pushed into English conventions.
 */
export function formatMoneyPdf(amountMinor: number, currency: string, locale = "en"): string {
  const major = toMajor(amountMinor, currency);
  let out: string;
  try {
    out = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "code",
    }).format(major);
  } catch {
    out = `${currency} ${major.toFixed(currencyDecimals(currency))}`;
  }
  return toWinAnsi(out);
}

/**
 * Replace anything a WinAnsi font cannot encode.
 *
 * Deliberately a WHITELIST of the characters money formatting actually
 * produces, rather than a blacklist of the ones seen breaking: the next locale
 * added to the catalogue must not be able to introduce a new broken glyph
 * silently. Anything unrecognised becomes a plain space, which is wrong-looking
 * at worst — never a different character that reads as data.
 */
export function toWinAnsi(s: string): string {
  return [...s]
    .map((ch) => {
      const cp = ch.codePointAt(0)!;
      // Printable ASCII, and the Latin-1 range WinAnsi shares with it.
      if (cp >= 0x20 && cp <= 0x7e) return ch;
      if (cp >= 0xa0 && cp <= 0xff) return cp === 0xa0 ? " " : ch;
      // Every space-like separator Intl emits.
      if (cp === 0x202f || cp === 0x2009 || cp === 0x2007 || cp === 0x2060) return " ";
      if (cp === 0x2212) return "-"; // MINUS SIGN, which some locales use
      return " ";
    })
    .join("");
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

// =============================================================================
// Paystack SETTLEMENT — which schools can be paid into their own bank
// =============================================================================
// Splitting a fee charge to a school's own account needs a Paystack subaccount,
// and creating one needs three country-specific things: the right bank list, an
// account number in that country's format, and — the part that actually keeps
// the money safe — the ability to resolve that account to a NAME the school
// reads back.
//
// The platform had none of them. `listBanks(country = "nigeria")` was called
// with no argument from the one place that matters, so a school in Accra was
// offered 279 NIGERIAN banks (verified live), and the account number was
// validated against `/^\d{10}$/` — a Nigerian NUBAN — in two places. A Ghanaian
// school, squarely inside Paystack's coverage, could not configure settlement at
// all; meanwhile its parents' fees were collected and held in the platform's own
// account, flagged `settledToPlatform`.
//
// A DATA TABLE, so adding a country is a row. Each entry says what was actually
// verified against the live API rather than what the docs imply.
export interface PaystackCountry {
  /** ISO 3166-1 alpha-2, matching `CountryProfile.code`. */
  code: string;
  /** The `country=` slug Paystack's /bank endpoint expects. */
  slug: string;
  /** What a school in this country is asked for. */
  accountLabel: string;
  /** Permissive bounds on the account number's digits. */
  minDigits: number;
  maxDigits: number;
  /**
   * Can `/bank/resolve` return the account holder's NAME here?
   *
   * This is not a detail. Creating a subaccount proves an account EXISTS, never
   * whose it is, and a transposed digit that lands on another valid account at
   * the same bank settles every parent's fee to a stranger — permanently, with
   * the invoice marked PAID at both ends. Reading the name back is the only
   * thing that catches it, so a country that cannot be verified is not offered
   * rather than offered unsafely.
   *
   * Verified against the live API: Nigeria, Ghana and Kenya all answer 422
   * "could not resolve account name" for a made-up number, which is the
   * endpoint working. South Africa answers 400 "Please supply one of the
   * following valid currencies: NGN, USD, GHS, KES" — ZAR is not one of them,
   * so the check cannot be performed there.
   */
  canResolveAccountName: boolean;
}

export const PAYSTACK_COUNTRIES: readonly PaystackCountry[] = [
  { code: "NG", slug: "nigeria", accountLabel: "10-digit NUBAN", minDigits: 10, maxDigits: 10, canResolveAccountName: true },
  { code: "GH", slug: "ghana", accountLabel: "bank account number", minDigits: 8, maxDigits: 20, canResolveAccountName: true },
  { code: "KE", slug: "kenya", accountLabel: "bank account number", minDigits: 6, maxDigits: 20, canResolveAccountName: true },
  // Listed deliberately, and NOT settleable: Paystack serves a South African
  // bank list but refuses to resolve an account name without one of NGN/USD/GHS/
  // KES. Offering the picker would let a school create a subaccount nobody had
  // verified, which is the one failure this whole flow exists to prevent.
  { code: "ZA", slug: "south africa", accountLabel: "bank account number", minDigits: 6, maxDigits: 20, canResolveAccountName: false },
] as const;

export function paystackCountry(code: string | null | undefined): PaystackCountry | null {
  if (!code) return null;
  return PAYSTACK_COUNTRIES.find((c) => c.code === code.toUpperCase()) ?? null;
}

/** Can a school in this country be paid into its own bank through Paystack? */
export function paystackCanSettleCountry(code: string | null | undefined): boolean {
  return paystackCountry(code)?.canResolveAccountName ?? false;
}

/** Why not, in words a school can act on. Null when it can. */
export function paystackSettlementBlocker(code: string | null | undefined): string | null {
  const c = paystackCountry(code);
  if (!c) return "Paystack does not settle to banks in this country. Collect fees by mobile money instead.";
  if (!c.canResolveAccountName) {
    return (
      "Paystack cannot confirm the account holder's name for accounts in this country, and this platform will not " +
      "route parents' fees to an account nobody has verified. Collect fees by mobile money instead."
    );
  }
  return null;
}
