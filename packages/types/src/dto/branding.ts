// School branding DTOs (per-tenant login-page logo).

/** Public, pre-auth branding for a school's login page (keyed by slug). */
export interface PublicBrandingDto {
  schoolName: string;
  /** Presigned/served logo URL, or null when none / subscription lapsed. */
  logoUrl: string | null;
}

/** Admin view of the caller's school branding. */
export interface SchoolBrandingDto {
  slug: string;
  logoKey: string | null;
  logoUrl: string | null;
}

/** Result of requesting a logo upload target (client PUTs bytes to uploadUrl). */
export interface BrandingUploadTargetDto {
  uploadUrl: string;
  key: string;
}
