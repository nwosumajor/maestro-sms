import { COMPLIANCE_PROFILES } from "./compliance-regime";
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
  /**
   * The month (1-12) the academic year normally OPENS in.
   *
   * Not cosmetic. It decides which session a school being set up today belongs
   * to, and the platform assumed September everywhere — which is six months
   * wrong for the whole of southern Africa. A school in Johannesburg, Harare or
   * Lusaka runs January to December, so a September default would have filed
   * their first registers against a session that does not exist yet.
   */
  academicYearStartMonth: number;
  /**
   * The shape of the year: how many periods and what they are called.
   *
   * Nigeria and the Commonwealth run three terms; the United States and Canada
   * run two semesters. The platform had the TWO_SEMESTER template defined and
   * unreachable — every path that created a calendar called the hard-coded
   * three-term generator — so an American school got "First/Second/Third Term"
   * and had to rebuild the year by hand.
   */
  calendarTemplate: string;
}

// "NONE" is retained as a legacy alias existing rows hold; complianceProfile()
// resolves it to UNSPECIFIED, which says "not modelled" rather than "none applies".
export const COMPLIANCE_REGIMES = Object.keys(COMPLIANCE_PROFILES).concat("NONE") as unknown as readonly string[];
export type ComplianceRegime = (typeof COMPLIANCE_REGIMES)[number];

/**
 * Supported countries.
 *
 * `payrollPack: null` is deliberate and load-bearing — it is how a country says
 * "we do not know your tax law". Emitting Nigerian PAYE for a British employee
 * would be worse than refusing, so payroll refuses.
 */
export const COUNTRIES: Record<string, CountryProfile> = {
  NG: { code: "NG", name: "Nigeria", timezone: "Africa/Lagos", locale: "en-NG", currency: "NGN", compliance: "NDPR", payrollPack: "NG" , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  GH: { code: "GH", name: "Ghana", timezone: "Africa/Accra", locale: "en-GH", currency: "GHS", compliance: "GH_DPA", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  KE: { code: "KE", name: "Kenya", timezone: "Africa/Nairobi", locale: "en-KE", currency: "KES", compliance: "KE_DPA", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  ZA: { code: "ZA", name: "South Africa", timezone: "Africa/Johannesburg", locale: "en-ZA", currency: "ZAR", compliance: "POPIA", payrollPack: null , academicYearStartMonth: 1 , calendarTemplate: "THREE_TERM" },
  // --- rest of Africa. `payrollPack: null` throughout: statutory rules differ by
  // country and none is implemented, so payroll refuses rather than borrowing
  // Nigeria's. Several of these use ZERO-DECIMAL currencies (XOF, XAF, RWF, UGX) —
  // see currency.ts, which is why money is scaled by the currency and not by 100.
  UG: { code: "UG", name: "Uganda", timezone: "Africa/Kampala", locale: "en-UG", currency: "UGX", compliance: "UG_DPPA", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  TZ: { code: "TZ", name: "Tanzania", timezone: "Africa/Dar_es_Salaam", locale: "en-TZ", currency: "TZS", compliance: "TZ_PDPA", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  RW: { code: "RW", name: "Rwanda", timezone: "Africa/Kigali", locale: "en-RW", currency: "RWF", compliance: "RW_DPL", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  ET: { code: "ET", name: "Ethiopia", timezone: "Africa/Addis_Ababa", locale: "en-ET", currency: "ETB", compliance: "ET_PDPP", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  ZM: { code: "ZM", name: "Zambia", timezone: "Africa/Lusaka", locale: "en-ZM", currency: "ZMW", compliance: "ZM_DPA", payrollPack: null , academicYearStartMonth: 1 , calendarTemplate: "THREE_TERM" },
  ZW: { code: "ZW", name: "Zimbabwe", timezone: "Africa/Harare", locale: "en-ZW", currency: "USD", compliance: "ZW_CDPA", payrollPack: null , academicYearStartMonth: 1 , calendarTemplate: "THREE_TERM" },
  BW: { code: "BW", name: "Botswana", timezone: "Africa/Gaborone", locale: "en-BW", currency: "BWP", compliance: "BW_DPA", payrollPack: null , academicYearStartMonth: 1 , calendarTemplate: "THREE_TERM" },
  NA: { code: "NA", name: "Namibia", timezone: "Africa/Windhoek", locale: "en-NA", currency: "NAD", compliance: "UNSPECIFIED", payrollPack: null , academicYearStartMonth: 1 , calendarTemplate: "THREE_TERM" },
  MW: { code: "MW", name: "Malawi", timezone: "Africa/Blantyre", locale: "en-MW", currency: "MWK", compliance: "MW_DPA", payrollPack: null , academicYearStartMonth: 1 , calendarTemplate: "THREE_TERM" },
  SL: { code: "SL", name: "Sierra Leone", timezone: "Africa/Freetown", locale: "en-SL", currency: "SLE", compliance: "UNSPECIFIED", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  LR: { code: "LR", name: "Liberia", timezone: "Africa/Monrovia", locale: "en-LR", currency: "LRD", compliance: "UNSPECIFIED", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  GM: { code: "GM", name: "The Gambia", timezone: "Africa/Banjul", locale: "en-GM", currency: "GMD", compliance: "UNSPECIFIED", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  // Francophone West Africa (XOF) — the UI is English-only today, so a school here
  // gets correct money and dates but an English interface. See the i18n note in
  // CLAUDE.md; the locale is set so it is ready when translations exist.
  SN: { code: "SN", name: "Senegal", timezone: "Africa/Dakar", locale: "fr-SN", currency: "XOF", compliance: "SN_2008", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  CI: { code: "CI", name: "Côte d'Ivoire", timezone: "Africa/Abidjan", locale: "fr-CI", currency: "XOF", compliance: "CI_2013", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  ML: { code: "ML", name: "Mali", timezone: "Africa/Bamako", locale: "fr-ML", currency: "XOF", compliance: "ML_2013", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  BJ: { code: "BJ", name: "Benin", timezone: "Africa/Porto-Novo", locale: "fr-BJ", currency: "XOF", compliance: "BJ_CODE", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  BF: { code: "BF", name: "Burkina Faso", timezone: "Africa/Ouagadougou", locale: "fr-BF", currency: "XOF", compliance: "BF_2004", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  TG: { code: "TG", name: "Togo", timezone: "Africa/Lome", locale: "fr-TG", currency: "XOF", compliance: "TG_2019", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  NE: { code: "NE", name: "Niger", timezone: "Africa/Niamey", locale: "fr-NE", currency: "XOF", compliance: "NE_2017", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  // Central Africa (XAF)
  CM: { code: "CM", name: "Cameroon", timezone: "Africa/Douala", locale: "fr-CM", currency: "XAF", compliance: "UNSPECIFIED", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  GA: { code: "GA", name: "Gabon", timezone: "Africa/Libreville", locale: "fr-GA", currency: "XAF", compliance: "GA_2011", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  CD: { code: "CD", name: "DR Congo", timezone: "Africa/Kinshasa", locale: "fr-CD", currency: "CDF", compliance: "CD_CODE", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  // North Africa
  EG: { code: "EG", name: "Egypt", timezone: "Africa/Cairo", locale: "ar-EG", currency: "EGP", compliance: "EG_PDPL", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  MA: { code: "MA", name: "Morocco", timezone: "Africa/Casablanca", locale: "fr-MA", currency: "MAD", compliance: "MA_0908", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  TN: { code: "TN", name: "Tunisia", timezone: "Africa/Tunis", locale: "fr-TN", currency: "TND", compliance: "TN_2004", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  GB: { code: "GB", name: "United Kingdom", timezone: "Europe/London", locale: "en-GB", currency: "GBP", compliance: "GDPR", payrollPack: "GB" , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  IE: { code: "IE", name: "Ireland", timezone: "Europe/Dublin", locale: "en-IE", currency: "EUR", compliance: "GDPR", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  AE: { code: "AE", name: "United Arab Emirates", timezone: "Asia/Dubai", locale: "en-AE", currency: "AED", compliance: "UNSPECIFIED", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  SA: { code: "SA", name: "Saudi Arabia", timezone: "Asia/Riyadh", locale: "en-SA", currency: "SAR", compliance: "UNSPECIFIED", payrollPack: null , academicYearStartMonth: 9 , calendarTemplate: "THREE_TERM" },
  IN: { code: "IN", name: "India", timezone: "Asia/Kolkata", locale: "en-IN", currency: "INR", compliance: "UNSPECIFIED", payrollPack: null , academicYearStartMonth: 4 , calendarTemplate: "THREE_TERM" },
  SG: { code: "SG", name: "Singapore", timezone: "Asia/Singapore", locale: "en-SG", currency: "SGD", compliance: "UNSPECIFIED", payrollPack: null , academicYearStartMonth: 1 , calendarTemplate: "THREE_TERM" },
  US: { code: "US", name: "United States", timezone: "America/New_York", locale: "en-US", currency: "USD", compliance: "UNSPECIFIED", payrollPack: null , academicYearStartMonth: 8 , calendarTemplate: "TWO_SEMESTER" },
  CA: { code: "CA", name: "Canada", timezone: "America/Toronto", locale: "en-CA", currency: "CAD", compliance: "UNSPECIFIED", payrollPack: null , academicYearStartMonth: 8 , calendarTemplate: "TWO_SEMESTER" },
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
