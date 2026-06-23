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
