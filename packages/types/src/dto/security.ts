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
  assignments: { id: string; name: string; email: string; roles: string[] }[];
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
