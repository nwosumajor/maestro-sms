// Announcements — school-wide notices.
export const ANNOUNCEMENT_PERMISSIONS = {
  /** Post / edit / delete a school announcement. principal / school_admin. */
  ANNOUNCEMENT_MANAGE: "announcement.manage",
  /** Read the school's announcements. Every role in a school. */
  ANNOUNCEMENT_READ: "announcement.read",
} as const;
export type AnnouncementPermission =
  (typeof ANNOUNCEMENT_PERMISSIONS)[keyof typeof ANNOUNCEMENT_PERMISSIONS];
