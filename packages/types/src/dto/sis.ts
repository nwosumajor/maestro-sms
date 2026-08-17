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

// -----------------------------------------------------------------------------
// The profile review queue
// -----------------------------------------------------------------------------
// The chain is: the pupil (or their parent) SUBMITS, the class SUPERVISOR checks
// it, then a school admin APPROVES. Each of those endpoints acts on one named
// pupil — which is fine once you know which pupil, and useless before. Nothing
// listed what was waiting, so the two review stages had no way in at all.
//
// One row per pupil awaiting the CALLER's action, with the stage stated so a
// single screen can serve both reviewers without asking them which they are.
export interface ProfileReviewRowDto {
  studentId: string;
  studentName: string;
  className: string | null;
  /** SUPERVISOR — waiting on the class supervisor's check.
   *  ADMIN — checked, waiting on a school admin's approval. */
  stage: "SUPERVISOR" | "ADMIN";
  submittedAt: Date | null;
  supervisorReviewedAt: Date | null;
}

// =============================================================================
// Who a pupil's parent actually is
// =============================================================================
// `parent_child` has always driven the things that MATTER — who receives the
// absence alert, the fee notice, the report card; whose /family page shows this
// child; which invoices a parent may open. The class page can create a link.
//
// Nothing could read one back. A teacher, a principal or an HR clerk looking at
// a pupil could not see which parent account was attached, or how to reach them.
// The emergency contacts on the SIS record are a different thing: those are
// people to telephone, entered as free text. This is the ACCOUNT the system is
// actually sending things to, and when a family says "we never got the invoice"
// it is the first question anyone asks.
export interface StudentGuardianDto {
  /** The parent's user id — the account, not a contact card. */
  id: string;
  name: string;
  /** The address notices really go to (a generated login identifier is not one). */
  email: string | null;
  phone: string | null;
  /** False when the account cannot receive email — the usual cause of "we were never told". */
  reachableByEmail: boolean;
}
