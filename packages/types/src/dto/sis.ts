// SIS (student profile / contacts / medical) response DTOs. Superset shapes:
// the display pages read all fields; the edit forms read a subset (Partial<…>).

export interface StudentProfileDto {
  studentId: string;
  admissionNumber: string | null;
  dateOfBirth: Date | null;
  gender: string | null;
  phone: string | null;
  email: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
}

export interface MedicalRecordDto {
  bloodGroup: string | null;
  allergies: string | null;
  conditions: string | null;
  medications: string | null;
  dietaryNotes: string | null;
  notes: string | null;
}

export interface ContactDto {
  id: string;
  name: string;
  relationship: string;
  phone: string;
  email: string | null;
  priority: number;
}

// =============================================================================
// SIS profile completion + review
// =============================================================================
// A bulk-imported pupil starts with a name and nothing else. These states drive
// the "finish your profile" loop: the pupil (or their parent) fills it in, submits
// it, their CLASS SUPERVISOR checks it, and the SCHOOL ADMIN approves.
//
// The pupil is nudged until it is SUBMITTED — not until APPROVED, because the wait
// after that is on staff, and nagging someone for work they cannot do is noise.

export const SIS_PROFILE_STATUSES = [
  "INCOMPLETE",
  "SUBMITTED",
  "CHANGES_REQUESTED",
  "APPROVED",
] as const;
export type SisProfileStatus = (typeof SIS_PROFILE_STATUSES)[number];

/**
 * Fields a pupil must supply before the profile counts as complete. Deliberately
 * the identity/contact minimum a school needs to operate — medical and emergency
 * contacts are handled separately (they are sensitive and staff-owned).
 */
export const SIS_REQUIRED_PROFILE_FIELDS = [
  "dateOfBirth",
  "gender",
  "phone",
  "addressLine1",
  "city",
  "state",
] as const;
export type SisRequiredField = (typeof SIS_REQUIRED_PROFILE_FIELDS)[number];

/** Pure: which required fields are still blank. Empty array = complete. */
export function missingProfileFields(
  profile: Partial<Record<SisRequiredField, unknown>> | null | undefined,
): SisRequiredField[] {
  if (!profile) return [...SIS_REQUIRED_PROFILE_FIELDS];
  return SIS_REQUIRED_PROFILE_FIELDS.filter((f) => {
    const v = profile[f];
    return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
  });
}

/** The pupil's own view of what is left to do. */
export interface SisCompletionDto {
  status: string;
  missing: string[];
  complete: boolean;
  /** Set when a reviewer sent it back, so the pupil knows what to change. */
  reviewNote: string | null;
  submittedAt: Date | null;
  approvedAt: Date | null;
}
