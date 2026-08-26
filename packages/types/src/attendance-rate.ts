// =============================================================================
// One definition of an attendance rate
// =============================================================================
// There were SIX, in two camps, and nothing said so:
//
//   present + late            report card (the printed artifact a family keeps),
//                             the analytics page, the parent dashboard
//   present + late + EXCUSED  the class board, the student summary,
//                             the attendance rollup
//
// So a pupil with authorised absences had two attendance percentages depending
// on which screen you opened. Measured on a real pupil over one term — 54
// present, 9 late, 2 absent, 5 excused of 70 — the report card printed **90%**
// and the student summary computed **97%**.
//
// // GOTCHA: the divergence was not only undocumented, it was written INTO a
// comment claiming the opposite. `getStudentSummary` carried "LATE counts as
// attending … Reporting it as an absence would understate attendance and
// contradict the report card" — on the very line that also adds `excused`,
// which the report card does not. The line written to avoid contradicting the
// report card contradicted it.
//
// WHICH ONE IS RIGHT: an EXCUSED absence is an absence. The pupil was not in
// school; the school has merely accepted the reason. An attendance rate answers
// "how much school did this child get", and authorised absence is the thing
// education authorities report SEPARATELY from attendance precisely because it
// is not attendance. LATE is different — the pupil was there.
//
// The printed report card, the analytics page and the parent dashboard already
// agreed on that. The three that did not are the internal screens.
// =============================================================================

export interface AttendanceCounts {
  present: number;
  late: number;
  absent: number;
  excused: number;
}

/** Records that make up the denominator. */
export function attendanceTotal(c: AttendanceCounts): number {
  return c.present + c.late + c.absent + c.excused;
}

/**
 * Whole-number attendance percentage, or null when no register was taken.
 *
 * NULL, not zero: "no register yet" and "attended nothing" are different facts
 * about a child, and reporting the first as the second is the mistake the
 * report card's own attendance block already documents.
 */
export function attendanceRatePct(c: AttendanceCounts): number | null {
  const total = attendanceTotal(c);
  if (total <= 0) return null;
  return Math.round(((c.present + c.late) / total) * 100);
}
