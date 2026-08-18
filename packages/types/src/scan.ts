// =============================================================================
// Scan actions
// =============================================================================
// A scan can RECORD an action, not just resolve identity. Each recorded scan
// writes an append-only scan_event; CHECK_IN additionally marks the student
// present in today's class register.
// =============================================================================
export const SCAN_PURPOSES = ["CHECK_IN", "CHECK_OUT", "LIBRARY", "EXAM"] as const;
export type ScanPurpose = (typeof SCAN_PURPOSES)[number];

export const SCAN_PURPOSE_LABELS: Record<ScanPurpose, string> = {
  CHECK_IN: "Check in (mark present)",
  CHECK_OUT: "Check out",
  LIBRARY: "Library",
  EXAM: "Exam hall",
};

export function isScanPurpose(v: string): v is ScanPurpose {
  return (SCAN_PURPOSES as readonly string[]).includes(v);
}

/**
 * ONE recorded movement.
 *
 * `scan_event` was written on every gate, library and exam-hall scan and read
 * by NOTHING — no endpoint, no query, no export. The desk recorded that a child
 * left the premises and the product could not answer "when did they leave?",
 * which is the only question a gate log exists for. The table already carried
 * the two indexes such a reader needs, `(schoolId, memberId)` and
 * `(schoolId, createdAt)` — it was designed to be read, and the readers were
 * never written. Retention projects it at 47M rows in ten years: the largest
 * table the platform stores, and none of it legible.
 */
export interface ScanEventDto {
  id: string;
  memberId: string;
  memberName: string;
  /** Who held the scanner. A movement log that cannot say who recorded it is
   *  half a record. */
  scannedById: string;
  scannedByName: string;
  purpose: ScanPurpose;
  note: string | null;
  at: Date;
}
