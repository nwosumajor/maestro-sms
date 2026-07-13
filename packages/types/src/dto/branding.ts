// School branding DTOs (per-tenant login-page logo).

/** Public, pre-auth branding for a school's login page (keyed by slug). */
export interface PublicBrandingDto {
  schoolName: string;
  /** Presigned/served logo URL, or null when none / subscription lapsed. */
  logoUrl: string | null;
}

/** Branding visible to ANY authenticated member of the school (AppShell). */
export interface MemberBrandingDto {
  schoolName: string;
  /** Presigned/served logo URL, or null when none / subscription lapsed. */
  logoUrl: string | null;
  brandHue: number | null;
  brandSat: number | null;
  brandLight: number | null;
  fontFamily: string | null;
}

// Logo shape/size contract, enforced server-side (byte-level header parse) and
// pre-checked client-side for a friendly error. Square-ish so one asset fits the
// login page, the AppShell header tile, and the PDF embeds without cropping.
export const LOGO_MIN_SIDE_PX = 128;
export const LOGO_MAX_SIDE_PX = 2048;
/** Max allowed |width/height - 1| — 10% keeps "visually square" without pixel-perfect demands. */
export const LOGO_ASPECT_TOLERANCE = 0.1;
export const LOGO_SHAPE_REQUIREMENT = `square (within 10%), ${LOGO_MIN_SIDE_PX}–${LOGO_MAX_SIDE_PX}px per side`;

/** Shared shape/size rule: square within tolerance, each side within bounds. */
export function isValidLogoDimensions(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  if (width < LOGO_MIN_SIDE_PX || height < LOGO_MIN_SIDE_PX) return false;
  if (width > LOGO_MAX_SIDE_PX || height > LOGO_MAX_SIDE_PX) return false;
  // |w/h - 1| <= tol, restated without the division so an exactly-at-tolerance
  // ratio (e.g. 550×500) isn't rejected by floating-point error.
  return Math.abs(width - height) <= LOGO_ASPECT_TOLERANCE * height;
}

/** Admin view of the caller's school branding (logo + theme). */
export interface SchoolBrandingDto {
  slug: string;
  logoKey: string | null;
  logoUrl: string | null;
  /** Brand colour (HSL) + font; null = inherit the platform defaults. */
  brandHue: number | null;
  brandSat: number | null;
  brandLight: number | null;
  fontFamily: string | null;
}

/** Result of requesting a logo upload target (client PUTs bytes to uploadUrl). */
export interface BrandingUploadTargetDto {
  uploadUrl: string;
  key: string;
}
