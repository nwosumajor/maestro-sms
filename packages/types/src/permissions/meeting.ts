// Parent-teacher meeting booking permissions.
export const MEETING_PERMISSIONS = {
  /** Open/manage appointment slots (teachers, staff). */
  MEETING_HOST: "meeting.host",
  /** Book a slot for one's own child (parents). */
  MEETING_BOOK: "meeting.book",
} as const;

export type MeetingPermission = (typeof MEETING_PERMISSIONS)[keyof typeof MEETING_PERMISSIONS];

export const MEETING_ROLE_PERMISSIONS = {
  teacher: [MEETING_PERMISSIONS.MEETING_HOST],
  school_admin: [MEETING_PERMISSIONS.MEETING_HOST],
  principal: [MEETING_PERMISSIONS.MEETING_HOST],
  parent: [MEETING_PERMISSIONS.MEETING_BOOK],
} as const;
