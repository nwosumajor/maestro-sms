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
