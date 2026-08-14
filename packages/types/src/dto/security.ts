// Security (privilege elevation / recertification / audit) response DTOs.

export interface PrivilegeGrantDto {
  id: string;
  userId: string;
  permission: string;
  reason: string;
  status: string;
  breakGlass: boolean;
  requestedById: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface RecertificationDto {
  roles: { name: string; permissions: string[] }[];
  /** Accounts holding a role BEYOND the non-staff baseline — the access a
   *  recertification is actually about. A pupil who also holds a staff role is
   *  here; a pupil who is only a pupil is not. */
  assignments: { id: string; name: string; email: string; roles: string[] }[];
  /** How many accounts were left out by that rule, so the page can SAY so
   *  rather than quietly present a shorter list as the whole school. */
  baselineAccountsExcluded: number;
  activeElevations: { id: string; permission: string; reason: string; breakGlass: boolean }[];
}

export interface SecurityAnomaliesDto {
  breakGlassCount: number;
  topMedicalReaders: { actorName: string; count: number }[];
  /**
   * Sign-in trouble over the same window.
   *
   * The platform locks an account PERMANENTLY on the third failure, and until
   * these events were recorded (#187) an operator reactivating one had nothing
   * to say why it locked. Recording them was only half the job: a signal nobody
   * is shown is not a signal, so they surface here beside break-glass, which is
   * where someone is already looking for exactly this kind of thing.
   */
  lockedOutCount: number;
  /** Accounts with the most failed attempts in the window, worst first. */
  topFailedLogins: { actorName: string; count: number; locked: boolean }[];
}

export interface AuditLogRowDto {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  actorName: string;
  createdAt: Date;
}

/** A page of audit rows + an opaque keyset cursor for the next page (null when
 *  the last page has been reached). */
export interface AuditLogPageDto {
  entries: AuditLogRowDto[];
  nextCursor: string | null;
}
