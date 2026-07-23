// Result of resolving a scanned ID-card code (uniqueId) within one school.
// Roster-level only — never medical or other sensitive PII.
export interface MemberScanDto {
  userId: string;
  uniqueId: string;
  name: string;
  /** Primary role label, e.g. "student", "teacher". */
  role: string;
  /** For students: their admission number and class, when available. */
  admissionNumber: string | null;
  className: string | null;
  /** ACTIVE / DISABLED etc — so a gate desk sees a revoked card. */
  status: string;
}
