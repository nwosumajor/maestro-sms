// =============================================================================
// Stable per-school entity codes (Subject.code, Class.code)
// =============================================================================
// Subjects and classes are referenced by NAME all over the product (pickers, CSV
// imports, timetables, question banks). A name is a poor key: it is free text,
// it gets re-typed with different spacing/casing, and two rows that look
// identical silently split assignments between them.
//
// `code` is the stable key. The operator may supply one; when they don't we
// derive it from the name using EXACTLY the rule the backfill migration used
// (20261101000000_subject_class_identity), so a row created by the app and a row
// created by the migration are indistinguishable.
// =============================================================================

/** Max characters in a derived code (before any de-duplication suffix). */
export const ENTITY_CODE_MAX = 8;

/**
 * Derive a code from a display name: strip non-alphanumerics, uppercase, cap at
 * ENTITY_CODE_MAX. Returns "" when the name has no alphanumerics at all — the
 * caller falls back to an id-derived code, matching the migration.
 *
 *   "Mathematics"      -> "MATHEMAT"
 *   "JSS 2A"           -> "JSS2A"
 *   "General Science"  -> "GENERALS"
 */
export function deriveEntityCode(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, ENTITY_CODE_MAX);
}

/**
 * Make a derived code unique within a school by appending the smallest numeric
 * suffix not already taken — the same de-duplication the migration applies.
 * `taken` is the set of codes already used in that school.
 */
export function uniqueEntityCode(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((c) => c.toUpperCase()));
  const base = deriveEntityCode(name);
  if (!base) return "";
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}${Date.now() % 100000}`;
}

/** Normalise an operator-supplied code so comparisons are predictable. */
export function normaliseEntityCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, ENTITY_CODE_MAX);
}
