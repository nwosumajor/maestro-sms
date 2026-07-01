// Small shared formatters for the module UIs.
//
// SECURITY/CORRECTNESS: locale AND timezone are PINNED, not left to the runtime.
// These formatters run in both the server render and the client hydration; a
// runtime-default locale/timezone differs between Node (UTC) and the browser
// (the user's zone), which makes React throw a hydration mismatch ("a client-side
// exception has occurred"). Fixing them to the platform's home locale/zone makes
// SSR and client output identical AND shows the correct West-Africa time.
const LOCALE = "en-NG";
const TIME_ZONE = "Africa/Lagos"; // WAT (UTC+1) — the platform's home timezone.

/** Money stored as integer minor units (kobo) -> a display string. */
export function money(amountMinor: number, currency = "NGN"): string {
  const major = (amountMinor ?? 0) / 100;
  try {
    return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).format(major);
  } catch {
    return `${currency} ${major.toFixed(2)}`;
  }
}

/** ISO date/datetime -> a short date (fixed locale + timezone). */
export function shortDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleDateString(LOCALE, { timeZone: TIME_ZONE, year: "numeric", month: "short", day: "numeric" });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** ISO datetime -> a short date+time (fixed locale + timezone). */
export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleString(LOCALE, {
      timeZone: TIME_ZONE,
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

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
