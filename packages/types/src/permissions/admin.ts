// Admin / RBAC governance — permission constants.
export const ADMIN_PERMISSIONS = {
  /** Assign/remove a user's roles within the tenant. school_admin / principal. */
  RBAC_MANAGE: "rbac.manage",
  /** Upload/remove the school's login-page logo. principal / school_admin. */
  SCHOOL_BRANDING_MANAGE: "school.branding.manage",
  /** Search the people directory. school_admin / principal (own school) and
   *  super_admin (ALL schools — branches on platform.operate in the service). */
  DIRECTORY_SEARCH: "directory.search",
} as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS];
