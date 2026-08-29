// =============================================================================
// Shared formatters — region-aware, and hydration-safe
// =============================================================================
// SECURITY/CORRECTNESS: locale and timezone are PINNED, never left to the runtime.
// These run in both the server render and the client hydration; a runtime-default
// locale/timezone differs between Node (UTC) and the browser (the user's zone),
// which makes React throw a hydration mismatch ("a client-side exception has
// occurred"). Both sides must be handed the SAME region, which is why it travels
// in the session rather than being read from the environment.
//
// It used to be pinned to the platform's own home — en-NG / Africa/Lagos — for
// every school on the platform. A parent in Dubai read their child's dates in West
// Africa Time and their fees with a ₦ in front. The region now comes from the
// school; the platform's home is only the fallback for a school that has not set
// one, so nothing changes for anyone already live.
//
// CALENDAR DATES ARE NOT TIMESTAMPS. A `@db.Date` column (a register date, a term
// start, a date of birth) is stored as midnight UTC and means a DAY, not an
// instant. Rendering one in a zone WEST of UTC shows the previous day — so a
// Toronto school would have seen every register dated a day early. Those are
// detected and rendered in UTC; only real timestamps are converted to the school's
// zone. See `isCalendarDate`.
// =============================================================================

import { formatMoney, toMajor, toMinor } from "@sms/types";

export interface DisplayRegion {
  locale: string;
  timezone: string;
  currency: string;
}

/** The platform's home region — the fallback, no longer the rule. */
export const PLATFORM_REGION: DisplayRegion = { locale: "en-NG", timezone: "Africa/Lagos", currency: "NGN" };

/** Session shape carrying the school's region (all optional for older sessions). */
export function regionOf(user?: { locale?: string; timezone?: string; currency?: string } | null): DisplayRegion {
  return {
    locale: user?.locale || PLATFORM_REGION.locale,
    timezone: user?.timezone || PLATFORM_REGION.timezone,
    currency: user?.currency || PLATFORM_REGION.currency,
  };
}

/**
 * Is this value a CALENDAR DATE rather than an instant?
 *
 * A `@db.Date` serialises as exactly midnight UTC. A real timestamp landing on
 * that millisecond is vanishingly rare, and if one did it would render as its UTC
 * day — off by at most a few hours on a value that carries no zone anyway. The
 * alternative was threading a "this is a date" flag through several hundred call
 * sites, which is churn that would itself introduce mistakes.
 */
function isCalendarDate(d: Date): boolean {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

/**
 * Money stored as integer minor units -> a display string in the given currency.
 *
 * Divides by the CURRENCY'S OWN scale, not by 100. The CFA franc has no centime,
 * and so do the Rwandan and Ugandan shilling and several others — dividing those
 * by 100 showed a hundredth of the real amount across roughly twenty African
 * countries. `formatMoney` in @sms/types is the single implementation.
 */
export function money(amountMinor: number, currency = PLATFORM_REGION.currency, locale = PLATFORM_REGION.locale): string {
  return formatMoney(amountMinor, currency, locale);
}

/** ISO date/datetime -> a short date. Calendar dates render in UTC; timestamps in
 *  the school's zone. */
export function shortDate(
  value: string | Date | null | undefined,
  region: Partial<DisplayRegion> = {},
): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const locale = region.locale || PLATFORM_REGION.locale;
  const timeZone = isCalendarDate(d) ? "UTC" : region.timezone || PLATFORM_REGION.timezone;
  try {
    return d.toLocaleDateString(locale, { timeZone, year: "numeric", month: "short", day: "numeric" });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** ISO datetime -> a short date+time in the school's zone. */
export function dateTime(value: string | Date | null | undefined, region: Partial<DisplayRegion> = {}): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const locale = region.locale || PLATFORM_REGION.locale;
  const timeZone = isCalendarDate(d) ? "UTC" : region.timezone || PLATFORM_REGION.timezone;
  try {
    return d.toLocaleString(locale, {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

/**
 * ISO datetime -> the time of day AT THE SCHOOL.
 *
 * The four places that showed a bare time called `toLocaleTimeString()` with no
 * timeZone, which takes the BROWSER's zone and locale. Two of them —
 * `MyAttendance` and `AttendanceAdmin` — receive their rows as props from the
 * server, so they render during SSR in the container's UTC and again in the
 * browser's zone: a hydration mismatch of the exact kind this file's header
 * warns about, on staff CLOCK-IN times, which feed lateness and pay.
 *
 * A time with no date is only ever an instant, so there is no `isCalendarDate`
 * case here: a `@db.Date` has no meaningful time of day to show.
 */
export function timeOfDay(value: string | Date | null | undefined, region: Partial<DisplayRegion> = {}): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleTimeString(region.locale || PLATFORM_REGION.locale, {
      timeZone: region.timezone || PLATFORM_REGION.timezone,
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

/** A date with its weekday, in the school's zone — for a roster, where "Tue" is
 *  the point. Same `isCalendarDate` rule as `shortDate`: a `@db.Date` is a DAY
 *  and must not be shifted into a zone. */
export function weekdayDate(value: string | Date | null | undefined, region: Partial<DisplayRegion> = {}): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const timeZone = isCalendarDate(d) ? "UTC" : region.timezone || PLATFORM_REGION.timezone;
  try {
    return d.toLocaleDateString(region.locale || PLATFORM_REGION.locale, {
      timeZone, weekday: "short", day: "numeric", month: "short",
    });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Formatters bound to one school's region — what a page or component uses once
 *  it knows where the school is. */
/**
 * TODAY, AS THE SCHOOL'S CALENDAR DAY — `YYYY-MM-DD`, ready for a date input.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date, and every screen that
 * prefills a date with it disagrees with the server about what day it is. East
 * of UTC that opens a register on YESTERDAY in the early morning; west of UTC it
 * opens TOMORROW all evening — and nobody looks, because the field is prefilled
 * and looks right.
 *
 * The API already decides the term lock, the 7-day stale rule and the register's
 * own filing date in the school's zone (`schoolToday(tz)`), so this is the web
 * side of one rule, not a second opinion.
 *
 * The zone must come from the SESSION, never from the runtime: a Node-vs-browser
 * default is a hydration mismatch, which a user sees as a blank page.
 *
 * en-CA formats as YYYY-MM-DD, which is exactly what `<input type="date">` wants.
 */
export function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

/**
 * What a person TYPED -> integer minor units, for sending to the API.
 *
 * The other half of `money`, and the half that was missing. Every form in the
 * web tier wrote `Math.round(Number(x) * 100)`: a salary, a loan, a fee item, a
 * late fee, an adjustment, a transport cost, a prepayment, an instalment. The
 * DISPLAY side had already been made region-aware — several of these components
 * read money through `useFormat().money` two lines above sending it — so they
 * showed a Senegalese school its francs correctly and then stored a hundred
 * times what the bursar typed.
 *
 * Reading is a wrong number on a screen. Writing is a wrong number on an
 * invoice, a payslip or a loan, which is why this direction matters more.
 */
export function minorFrom(amountMajor: string | number, currency = PLATFORM_REGION.currency): number {
  const n = typeof amountMajor === "number" ? amountMajor : parseFloat(amountMajor || "0");
  return Number.isFinite(n) ? toMinor(n, currency) : 0;
}

/** Integer minor units -> a bare major number, for PREFILLING an input. Not for
 *  display: `money` is for display, and this deliberately carries no symbol. */
export function majorFrom(amountMinor: number, currency = PLATFORM_REGION.currency): number {
  return toMajor(amountMinor ?? 0, currency);
}

export function formattersFor(region: DisplayRegion) {
  return {
    region,
    money: (minor: number, currency?: string) => money(minor, currency || region.currency, region.locale),
    /** Typed amount -> minor units, in the school's currency. */
    minorFrom: (major: string | number, currency?: string) => minorFrom(major, currency || region.currency),
    /** Minor units -> a bare major number, for prefilling an input. */
    majorFrom: (minor: number, currency?: string) => majorFrom(minor, currency || region.currency),
    shortDate: (v: string | Date | null | undefined) => shortDate(v, region),
    dateTime: (v: string | Date | null | undefined) => dateTime(v, region),
    timeOfDay: (v: string | Date | null | undefined) => timeOfDay(v, region),
    weekdayDate: (v: string | Date | null | undefined) => weekdayDate(v, region),
    /** Today, as the school reckons it — see `todayIn`. */
    today: () => todayIn(region.timezone),
  };
}

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
