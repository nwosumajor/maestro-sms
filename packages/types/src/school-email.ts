// =============================================================================
// School-scoped login identifiers
// =============================================================================
// `user.email` is GLOBALLY unique (one index, no schoolId — login happens before
// a school is known, so it has to be). That made a real collision unavoidable:
// the same person, or two people sharing a name, at two different schools.
//
// The column no longer carries two jobs:
//
//   email        -> LOGIN IDENTIFIER: firstname.lastname@<slug>.com
//                   Unique by construction, because school.slug is unique.
//   contactEmail -> the real, deliverable address. Where mail actually goes.
//
//   "Adams James" at Maestro High  -> adams.james@maestro.com
//   "Adams James" at St Andrews    -> adams.james@standrews.com
//
// So a parent with children at two schools, or a teacher working at both, stops
// being a support ticket.
//
// !! READ THIS BEFORE SENDING ANYTHING TO `email` !!
// These domains are NOT ours and in general belong to unrelated companies.
// A login identifier here is a STRING TO TYPE AT A LOGIN BOX, never a mailbox.
// Delivering to one would post student data and password-reset links to a
// stranger's mail server, and it would fail silently. That is why:
//   * `user.loginEmailGenerated` records explicitly what we minted, and
//   * `deliverableEmail()` returns NULL for such a user rather than falling back.
// Detection is a stored FLAG, not string-matching on the domain, precisely
// because the domain is arbitrary and unguessable from the address alone.
// =============================================================================

/** Longest generated slug. Short enough to type as a domain and read on a card. */
export const MAX_SCHOOL_SLUG_LENGTH = 12;

/** Words that carry no identity — dropped when shortening a school name. */
const SLUG_STOPWORDS = new Set([
  "school", "schools", "academy", "college", "institute", "institution",
  "international", "intl", "secondary", "primary", "nursery", "high",
  "comprehensive", "grammar", "the", "of", "and", "for", "group",
  "education", "educational", "centre", "center", "ltd", "limited",
]);

/** Strip a string to lowercase a-z0-9, handling accents and apostrophes. */
function asciiFold(part: string): string {
  return part
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining accents
    .toLowerCase()
    .replace(/['’`]/g, "") // O'Brien -> obrien
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * A SHORT, readable slug for a school, derived from its name.
 *   "Maestro High School"          -> "maestro"
 *   "St. Andrews Academy"          -> "standrews"
 *   "Elshaddi British High School" -> "elshaddibrit"  (capped)
 * Meaningless words are dropped first so the identity survives the cap.
 */
export function baseSchoolSlug(schoolName: string, maxLength = MAX_SCHOOL_SLUG_LENGTH): string {
  const words = schoolName.split(/\s+/).map(asciiFold).filter(Boolean);
  const meaningful = words.filter((w) => !SLUG_STOPWORDS.has(w));
  // Everything was a stopword ("The School") — fall back to the raw words.
  const source = meaningful.length > 0 ? meaningful : words;
  const joined = source.join("");
  const slug = joined.slice(0, maxLength);
  return slug || "school";
}

/**
 * Slug candidates in preference order. The caller takes the first one not
 * already used by another school — school.slug is UNIQUE, so two schools can
 * never share one, which is what makes the login domain unambiguous.
 */
export function schoolSlugCandidates(
  schoolName: string,
  howMany = 50,
  maxLength = MAX_SCHOOL_SLUG_LENGTH,
): string[] {
  const base = baseSchoolSlug(schoolName, maxLength);
  return Array.from({ length: howMany }, (_, i) => {
    if (i === 0) return base;
    const suffix = String(i + 1);
    // Keep the total within the cap by trimming the base, not overflowing it.
    return base.slice(0, Math.max(1, maxLength - suffix.length)) + suffix;
  });
}

/** The school's login domain: `<slug>.com`. */
export function schoolLoginDomain(schoolSlug: string): string {
  return `${asciiFold(schoolSlug)}.com`;
}

/**
 * The local part of a login identifier: every name part, dot-separated.
 *   "Adams James"        -> adams.james
 *   "Adams Chidi James"  -> adams.chidi.james
 *   "Madonna"            -> madonna
 *
 * Middle names are KEPT deliberately. An earlier version used first+surname
 * only, which made the collision message self-defeating: it told the
 * administrator to "include a middle name", and then discarded it — so the
 * second Adams James still clashed. Keeping every part means the natural human
 * fix actually resolves the clash.
 *
 * Returns "" when nothing usable survives (caller must handle).
 */
export function loginLocalPart(fullName: string): string {
  const parts = fullName.split(/\s+/).map(asciiFold).filter(Boolean);
  return parts.join(".");
}

/**
 * `firstname.lastname@<slug>.com`, optionally numbered.
 *
 * `suffix` 0 => no number (the base), 1 => `...2`, 2 => `...3`, ... A human
 * counts from 2, not from 0. The PURE function is deterministic; whether to walk
 * suffixes on a clash is the ALLOCATOR's decision, and differs by role:
 *   - STAFF: no walk. Two colleagues sharing a name is an ambiguity a human
 *     resolves (the admin is told to use a fuller name) — a silent adams.james2
 *     would give them near-identical logins they type daily.
 *   - STUDENTS: walk. Shared names are the norm on a large roll, pupils receive
 *     a printed login slip (the ID need not be memorable), and blocking the
 *     import would force endless CSV edits. See the allocator.
 */
export function generateLoginEmail(fullName: string, schoolSlug: string, suffix = 0): string {
  const local = loginLocalPart(fullName) || "user";
  const n = suffix > 0 ? String(suffix + 1) : "";
  return `${local}${n}@${schoolLoginDomain(schoolSlug)}`;
}

/**
 * Where mail for this user should actually go — or null if nowhere.
 *
 * A GENERATED identifier is never a fallback: its domain is not ours. The flag
 * is authoritative; `email` is only trusted when the account predates this
 * scheme (its address really is the person's own).
 */
export function deliverableEmail(user: {
  email?: string | null;
  contactEmail?: string | null;
  loginEmailGenerated?: boolean | null;
}): string | null {
  const contact = user.contactEmail?.trim();
  if (contact) return contact;
  if (user.loginEmailGenerated) return null; // not a mailbox — do not send
  const legacy = user.email?.trim();
  return legacy || null;
}

/**
 * Does this role need a real, deliverable address?
 *
 * Everyone except STUDENTS. A student's login identifier is generated and their
 * guardians receive the mail, so requiring one would block enrolment for the
 * many pupils who have no address. Staff and parents DO need one — without it
 * they can never receive a password reset, an invite, or a receipt, and the
 * account becomes unrecoverable the moment they forget their password.
 */
export function requiresContactEmail(roleName: string): boolean {
  return roleName !== "student";
}

/**
 * On a within-school NAME clash, should the login identifier auto-number
 * (adams.james -> adams.james2) instead of refusing?
 *
 * YES for STUDENTS and PARENTS — high-volume, onboarded from lists, and they
 * receive a printed slip / invite rather than typing a memorised address, so a
 * numbered login is fine and blocking the row would just force a re-upload.
 * NO for STAFF — few, individually managed, and they type their login daily, so
 * a near-identical adams.james2 invites years of sign-in mistakes; the admin is
 * asked for a fuller name instead.
 */
export function autoSuffixLoginOnClash(roleName: string): boolean {
  return roleName === "student" || roleName === "parent";
}
