// Admin / RBAC governance — permission constants.
export const ADMIN_PERMISSIONS = {
  /** Assign/remove a user's roles within the tenant. school_admin / principal. */
  RBAC_MANAGE: "rbac.manage",
} as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS];
