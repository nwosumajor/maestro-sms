// Parent-teacher meeting booking permissions.
export const MEETING_PERMISSIONS = {
  /** Open/manage appointment slots (teachers, staff). */
  MEETING_HOST: "meeting.host",
  /** Book a slot for one's own child (parents). */
  MEETING_BOOK: "meeting.book",
  /** Ask a teacher for a meeting about one's own child (parents). Distinct from
   *  BOOK: booking takes a time the teacher already offered, requesting asks
   *  for one that does not exist yet. */
  MEETING_REQUEST: "meeting.request",
  /** See meeting requests. Held by parents, teachers AND leadership — the three
   *  audiences of one list — because the SERVICE decides which rows each of
   *  them gets. A single permission per audience would need three endpoints
   *  returning the same shape. */
  MEETING_REQUEST_READ: "meeting.request.read",
} as const;

export type MeetingPermission = (typeof MEETING_PERMISSIONS)[keyof typeof MEETING_PERMISSIONS];

export const MEETING_ROLE_PERMISSIONS = {
  teacher: [MEETING_PERMISSIONS.MEETING_HOST, MEETING_PERMISSIONS.MEETING_REQUEST_READ],
  school_admin: [MEETING_PERMISSIONS.MEETING_HOST, MEETING_PERMISSIONS.MEETING_REQUEST_READ],
  principal: [MEETING_PERMISSIONS.MEETING_HOST, MEETING_PERMISSIONS.MEETING_REQUEST_READ],
  parent: [MEETING_PERMISSIONS.MEETING_BOOK, MEETING_PERMISSIONS.MEETING_REQUEST, MEETING_PERMISSIONS.MEETING_REQUEST_READ],
} as const;
