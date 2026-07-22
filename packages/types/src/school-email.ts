// =============================================================================
// School-scoped login identifiers
// =============================================================================
// `user.email` is GLOBALLY unique (one index, no schoolId — login happens before
// a school is known, so it has to be). That made a real-world collision
// unavoidable: the same person, or two people sharing a name, at two different
// schools on the platform.
//
// The fix is to stop making that column carry two jobs:
//
//   email        -> LOGIN IDENTIFIER. Generated here, unique by construction
//                   because the school's own unique `slug` is the subdomain.
//                   Never used as a delivery target.
//   contactEmail -> the real, deliverable address. Where mail actually goes.
//
//   "Adams James" at St Andrews  -> adams.james@standrews.majormaestro.com
//   "Adams James" at Maestro     -> adams.james@maestro.majormaestro.com
//
// The two no longer collide, so a parent with children at two schools, or a
// teacher working at both, stops being a support ticket.
//
// SECURITY: the domain must be one WE control. A made-up domain would send
// password-reset links and student data to a stranger's mail server, silently.
// Nothing is ever delivered to a generated address — see `isGeneratedLoginEmail`.
// =============================================================================

/** Base domain for generated login identifiers. Must be a domain we own. */
export const LOGIN_EMAIL_DOMAIN = "majormaestro.com";

/**
 * Strip a display name down to an email-safe slug part.
 * Handles accents, apostrophes and hyphens the way Nigerian and international
 * school rolls actually contain them ("N'Diaye", "Obi-Eze", "Ọláwálé").
 */
function slugifyNamePart(part: string): string {
  return part
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents
    .toLowerCase()
    .replace(/['’`]/g, "") // O'Brien -> obrien
    .replace(/[^a-z0-9]+/g, "") // drop everything else
    .trim();
}

/**
 * The local part of a login identifier: `first.last`.
 * - One name        -> that name alone ("Madonna" -> "madonna")
 * - Three or more   -> first + LAST ("Adams Chidi James" -> "adams.james"),
 *                      because the surname is what people identify with.
 * Returns "" when nothing usable survives (caller must handle).
 */
export function loginLocalPart(fullName: string): string {
  const parts = fullName
    .split(/\s+/)
    .map(slugifyNamePart)
    .filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]}.${parts[parts.length - 1]}`;
}

/** The per-school mail domain: `<slug>.<LOGIN_EMAIL_DOMAIN>`. */
export function schoolLoginDomain(schoolSlug: string, baseDomain = LOGIN_EMAIL_DOMAIN): string {
  const sub = slugifyNamePart(schoolSlug.replace(/[^a-zA-Z0-9]+/g, "-").replace(/-/g, ""));
  return `${sub}.${baseDomain}`;
}

/**
 * Build a login identifier. `suffix` disambiguates a WITHIN-SCHOOL clash — two
 * real people who genuinely share a name — as adams.james2, adams.james3, ...
 * Cross-school clashes cannot happen: the domain differs.
 */
export function generateLoginEmail(
  fullName: string,
  schoolSlug: string,
  suffix = 0,
  baseDomain = LOGIN_EMAIL_DOMAIN,
): string {
  const local = loginLocalPart(fullName) || "user";
  const n = suffix > 0 ? String(suffix + 1) : "";
  return `${local}${n}@${schoolLoginDomain(schoolSlug, baseDomain)}`;
}

/**
 * Candidate identifiers in preference order, for a caller that will test each
 * against the database and take the first free one.
 */
export function loginEmailCandidates(
  fullName: string,
  schoolSlug: string,
  howMany = 25,
  baseDomain = LOGIN_EMAIL_DOMAIN,
): string[] {
  return Array.from({ length: howMany }, (_, i) =>
    generateLoginEmail(fullName, schoolSlug, i, baseDomain),
  );
}

/**
 * Is this address one we generated? Such an address has NO mailbox behind it, so
 * the notification layer must never treat it as a delivery target — doing so
 * would drop receipts and reset links on the floor without erroring.
 */
export function isGeneratedLoginEmail(
  email: string | null | undefined,
  baseDomain = LOGIN_EMAIL_DOMAIN,
): boolean {
  // Null-safe: callers pass rows straight from the DB, and a partial select (or
  // a user record without an address) must not throw inside the delivery path.
  return typeof email === "string" && email.trim().toLowerCase().endsWith(`.${baseDomain}`);
}

/**
 * Where mail for this user should actually go — or null if nowhere.
 * A generated login identifier is NOT a fallback; it is not a mailbox.
 */
export function deliverableEmail(user: {
  email?: string | null;
  contactEmail?: string | null;
}): string | null {
  const contact = user.contactEmail?.trim();
  if (contact) return contact;
  const login = user.email?.trim();
  if (!login) return null;
  return isGeneratedLoginEmail(login) ? null : login;
}
