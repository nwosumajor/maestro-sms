// Public (pre-auth) website DTOs: the school directory + onboarding intake.

/** A school as shown in the public directory (no tenant data). */
export interface PublicSchoolDto {
  id: string;
  name: string;
  slug: string;
}

/** A prospective principal's request to put their school on the platform. */
export interface OnboardingRequestDto {
  id: string;
  schoolName: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  desiredSlug: string | null;
  notes: string | null;
  status: string;
  reviewNote: string | null;
  createdAt: Date;
}
