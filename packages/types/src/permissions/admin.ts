// Admin / RBAC governance — permission constants.
export const ADMIN_PERMISSIONS = {
  /** Assign/remove a user's roles within the tenant. school_admin / principal. */
  RBAC_MANAGE: "rbac.manage",
  /** Upload/remove the school's login-page logo. principal / school_admin. */
  SCHOOL_BRANDING_MANAGE: "school.branding.manage",
  /** Search the people directory. school_admin / principal (own school) and
   *  super_admin (ALL schools — branches on platform.operate in the service). */
  DIRECTORY_SEARCH: "directory.search",
  /** List people in THIS school as picker options — id + name + roles, never an
   *  email address. Every feature that asks "who?" needs this: assign an
   *  invigilator, address an announcement, request a meeting with a teacher,
   *  pick a driver, name a staff member on a certificate.
   *
   *  It exists because those pickers were reading GET /users, which requires
   *  class.write and carries emails. Eight roles hold the feature permission and
   *  not class.write, so their picker rendered EMPTY with no error — a parent
   *  could not choose a teacher to request a meeting, an hr_clerk could not pick
   *  a staff member.
   *
   *  Deliberately NOT message.send, which every one of those roles happens to
   *  hold: authorising an exam roster through a messaging permission means the
   *  roster breaks silently the day someone revokes messaging. */
  PEOPLE_READ: "directory.people.read",
} as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS];
