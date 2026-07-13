// Public (pre-auth) website DTOs: the school directory + onboarding intake.

/** A school as shown in the public directory (no tenant data). */
export interface PublicSchoolDto {
  id: string;
  name: string;
  slug: string;
}

/** Shared vocab for the public onboarding intake — one source for the form's
 *  selects AND the API's validation, so they can never drift. */
export const ONBOARDING_SCHOOL_TYPES = [
  "PRIMARY",
  "SECONDARY",
  "PRIMARY_AND_SECONDARY",
  "TERTIARY",
  "OTHER",
] as const;
export type OnboardingSchoolType = (typeof ONBOARDING_SCHOOL_TYPES)[number];

export const ONBOARDING_CONTACT_ROLES = [
  "PROPRIETOR",
  "PRINCIPAL",
  "SCHOOL_ADMINISTRATOR",
  "IT_STAFF",
  "OTHER",
] as const;
export type OnboardingContactRole = (typeof ONBOARDING_CONTACT_ROLES)[number];

/** A prospective principal's request to put their school on the platform. */
export interface OnboardingRequestDto {
  id: string;
  schoolName: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  desiredSlug: string | null;
  /** Requested tier + add-on module keys — a wish recorded at intake; the
   *  operator decides the real plan/modules at provisioning. */
  desiredPlan: string | null;
  desiredModules: string[] | null;
  /** School profile (requester-supplied sales-qualifying detail). */
  schoolType: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  website: string | null;
  studentCount: number | null;
  staffCount: number | null;
  contactRole: string | null;
  currentSystem: string | null;
  notes: string | null;
  status: string;
  reviewNote: string | null;
  createdAt: Date;
}
