/** One duty the platform owner has lent to a platform manager, with its expiry. */
export interface PlatformDelegationDto {
  id: string;
  /** The manager holding the duty. */
  userId: string;
  userName: string;
  userEmail: string;
  /** A delegable platform permission, e.g. "platform.onboarding.review". */
  permission: string;
  reason: string;
  grantedById: string;
  grantedByName: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedByName: string | null;
  /** Live right now: not revoked and not yet expired. Computed server-side so the
   *  console and the permission guard can never disagree about who holds what. */
  active: boolean;
  /** Whole days remaining; 0 once expired. */
  daysLeft: number;
}
