// Platform operator (super_admin) — cross-tenant console + audited impersonation.
export const OPERATOR_PERMISSIONS = {
  /** Operate the platform: list tenants, impersonate (audited). super_admin only. */
  PLATFORM_OPERATE: "platform.operate",
} as const;
export type OperatorPermission = (typeof OPERATOR_PERMISSIONS)[keyof typeof OPERATOR_PERMISSIONS];
