// =============================================================================
// Region — where a school actually is
// =============================================================================
// The platform was written for one country and said so in three places: the web
// pinned `en-NG` / `Africa/Lagos`, the server decided "today" in UTC, and money
// was ₦ in twenty components. None of that is configuration — a school in
// Singapore had no way to say where it was.
//
// The timezone is the one that corrupts data rather than merely looking wrong.
// "Today" for a register is a CALENDAR DAY at the school, not a UTC instant:
//
//   Singapore (UTC+8)  Monday 07:30 local = Sunday 23:30 UTC  -> filed Sunday
//   Toronto   (UTC-5)  Monday 19:30 local = Tuesday 00:30 UTC -> filed Tuesday
//
// So attendance, the gate scan, the term lock and every "is this register stale"
// decision must ask the SCHOOL what day it is, never the server.
//
// Defaults preserve today's behaviour exactly: an existing school with no region
// set is Nigeria, WAT, en-NG, NGN. Nothing changes for them.
// =============================================================================

/** A country the platform is set up to serve. Adding one is a data change here,
 *  not new code — the same posture as roles and modules. */
export interface CountryProfile {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
  /** IANA zone. The single most important field: it decides what "today" means. */
  timezone: string;
  /** BCP-47, for date and number formatting. */
  locale: string;
  /** ISO 4217 — the currency a school in this country charges fees in. */
  currency: string;
  /** Which privacy regime this country falls under. */
  compliance: ComplianceRegime;
  /** Payroll pack key, or null when statutory payroll is not implemented for this
   *  country — in which case payroll is REFUSED rather than computed wrongly. */
  payrollPack: string | null;
}

export const COMPLIANCE_REGIMES = ["NDPR", "GDPR", "NONE"] as const;
export type ComplianceRegime = (typeof COMPLIANCE_REGIMES)[number];

/**
 * Supported countries.
 *
 * `payrollPack: null` is deliberate and load-bearing — it is how a country says
 * "we do not know your tax law". Emitting Nigerian PAYE for a British employee
 * would be worse than refusing, so payroll refuses.
 */
export const COUNTRIES: Record<string, CountryProfile> = {
  NG: { code: "NG", name: "Nigeria", timezone: "Africa/Lagos", locale: "en-NG", currency: "NGN", compliance: "NDPR", payrollPack: "NG" },
  GH: { code: "GH", name: "Ghana", timezone: "Africa/Accra", locale: "en-GH", currency: "GHS", compliance: "NONE", payrollPack: null },
  KE: { code: "KE", name: "Kenya", timezone: "Africa/Nairobi", locale: "en-KE", currency: "KES", compliance: "NONE", payrollPack: null },
  ZA: { code: "ZA", name: "South Africa", timezone: "Africa/Johannesburg", locale: "en-ZA", currency: "ZAR", compliance: "NONE", payrollPack: null },
  GB: { code: "GB", name: "United Kingdom", timezone: "Europe/London", locale: "en-GB", currency: "GBP", compliance: "GDPR", payrollPack: null },
  IE: { code: "IE", name: "Ireland", timezone: "Europe/Dublin", locale: "en-IE", currency: "EUR", compliance: "GDPR", payrollPack: null },
  AE: { code: "AE", name: "United Arab Emirates", timezone: "Asia/Dubai", locale: "en-AE", currency: "AED", compliance: "NONE", payrollPack: null },
  SA: { code: "SA", name: "Saudi Arabia", timezone: "Asia/Riyadh", locale: "en-SA", currency: "SAR", compliance: "NONE", payrollPack: null },
  IN: { code: "IN", name: "India", timezone: "Asia/Kolkata", locale: "en-IN", currency: "INR", compliance: "NONE", payrollPack: null },
  SG: { code: "SG", name: "Singapore", timezone: "Asia/Singapore", locale: "en-SG", currency: "SGD", compliance: "NONE", payrollPack: null },
  US: { code: "US", name: "United States", timezone: "America/New_York", locale: "en-US", currency: "USD", compliance: "NONE", payrollPack: null },
  CA: { code: "CA", name: "Canada", timezone: "America/Toronto", locale: "en-CA", currency: "CAD", compliance: "NONE", payrollPack: null },
};

/** The platform's home country. An existing school with no region set is this,
 *  so nothing changes for anyone already live. */
export const DEFAULT_COUNTRY = "NG";

export function countryProfile(code: string | null | undefined): CountryProfile {
  return COUNTRIES[(code ?? DEFAULT_COUNTRY).toUpperCase()] ?? COUNTRIES[DEFAULT_COUNTRY];
}

/** A school's effective region — explicit columns win over the country default,
 *  so a British school billing in USD is expressible. */
export interface RegionProfile {
  country: string;
  timezone: string;
  locale: string;
  currency: string;
  compliance: ComplianceRegime;
  payrollPack: string | null;
}

export function resolveRegion(school: {
  country?: string | null;
  timezone?: string | null;
  locale?: string | null;
  currency?: string | null;
  complianceRegime?: string | null;
}): RegionProfile {
  const base = countryProfile(school.country);
  const compliance = (COMPLIANCE_REGIMES as readonly string[]).includes(school.complianceRegime ?? "")
    ? (school.complianceRegime as ComplianceRegime)
    : base.compliance;
  return {
    country: base.code,
    timezone: school.timezone || base.timezone,
    locale: school.locale || base.locale,
    currency: school.currency || base.currency,
    compliance,
    payrollPack: base.payrollPack,
  };
}

// --- what day is it, where the school is -------------------------------------

/**
 * The calendar date AT THE SCHOOL, as YYYY-MM-DD.
 *
 * This is the function that fixes the register bug. `new Date()` on the server is
 * a UTC instant; a school in Singapore or Toronto needs the day THEY are having.
 * Implemented with Intl rather than arithmetic so daylight saving is handled by
 * the platform's own tz database rather than by us.
 */
export function schoolDateString(timezone: string, at: Date = new Date()): string {
  try {
    // en-CA gives YYYY-MM-DD directly, which is what every date column wants.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    // An invalid zone must not take a register down; fall back to UTC and let the
    // school's region be corrected rather than losing the day entirely.
    return at.toISOString().slice(0, 10);
  }
}

/**
 * The school's current calendar day as a UTC-midnight Date — the form every
 * `@db.Date` column in this schema stores.
 *
 * Note what this is NOT: it is not "now converted to the school's zone". It is
 * the school's DATE, pinned to midnight UTC, so that two schools in different
 * zones recording the same local Monday both store the same Monday.
 */
export function schoolToday(timezone: string, at: Date = new Date()): Date {
  return new Date(`${schoolDateString(timezone, at)}T00:00:00.000Z`);
}

/** Whole days between two school-local dates. Used by the stale-register rule, so
 *  that "more than 7 days old" means seven of the school's days. */
export function daysBetweenSchoolDates(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}
