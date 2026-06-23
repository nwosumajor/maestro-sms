import { SetMetadata } from "@nestjs/common";

export const PERMISSION_KEY = "sms:required_permission";

/**
 * Gate a route on a fine-grained permission string (e.g. "integrity.report.read").
 * Enforced by PermissionGuard, backstopped by Postgres RLS at the data layer.
 */
export const RequirePermission = (permission: string) =>
  SetMetadata(PERMISSION_KEY, permission);
