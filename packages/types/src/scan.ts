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
