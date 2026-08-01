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

/** Money stored as integer minor units -> a display string in the given currency. */
export function money(amountMinor: number, currency = PLATFORM_REGION.currency, locale = PLATFORM_REGION.locale): string {
  const major = (amountMinor ?? 0) / 100;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(major);
  } catch {
    // An unknown currency or locale must still render a number, not blank.
    return `${currency} ${major.toFixed(2)}`;
  }
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

/** Formatters bound to one school's region — what a page or component uses once
 *  it knows where the school is. */
export function formattersFor(region: DisplayRegion) {
  return {
    region,
    money: (minor: number, currency?: string) => money(minor, currency || region.currency, region.locale),
    shortDate: (v: string | Date | null | undefined) => shortDate(v, region),
    dateTime: (v: string | Date | null | undefined) => dateTime(v, region),
  };
}

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
