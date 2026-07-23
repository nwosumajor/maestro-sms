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

// Result of RECORDING a scan action (POST). Carries the resolved member plus
// what the scan did, so the desk shows immediate confirmation.
export interface ScanRecordResultDto {
  member: MemberScanDto;
  purpose: string;
  recorded: true;
  /** For CHECK_IN of a student: the class they were marked present in, or a
   *  reason it could not be marked (e.g. not enrolled). Null for other purposes. */
  attendanceMarkedClass: string | null;
  attendanceNote: string | null;
}
