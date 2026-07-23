// =============================================================================
// Admission numbers
// =============================================================================
// Every enrolled student gets a stable, unique-per-school admission number. It
// is the RELIABLE key for referencing a pupil — e.g. linking a guardian to a
// child in the parent import — because a student's email is a generated login
// nobody memorises and names collide.
//
// A school may supply its own numbers on import; when a row leaves it blank one
// is GENERATED here as `<year>/<4-digit sequence>` (e.g. 2026/0001), sequential
// within the school. Uniqueness is also enforced at the DB layer
// (@@unique([schoolId, admissionNumber])).
// =============================================================================

/** `2026/0001`. */
export function formatAdmissionNumber(year: number, seq: number): string {
  return `${year}/${String(seq).padStart(4, "0")}`;
}

/** Matches a generated number and captures (year, seq). */
export const ADMISSION_NUMBER_RE = /^(\d{4})\/(\d+)$/;

/**
 * The next free sequence for `year`, given the numbers already in use in the
 * school. Only considers our generated `<year>/NNNN` shape — a school's own
 * custom numbers (e.g. "STA-12") are ignored for sequencing but still occupy the
 * used-set, so a generated candidate that happens to collide is skipped by the
 * caller.
 */
export function nextAdmissionSeq(existing: Iterable<string>, year: number): number {
  let max = 0;
  for (const a of existing) {
    const m = ADMISSION_NUMBER_RE.exec(a);
    if (m && Number(m[1]) === year) max = Math.max(max, Number(m[2]));
  }
  return max + 1;
}
