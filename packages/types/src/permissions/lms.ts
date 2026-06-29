// =============================================================================
// LMS — permission constants (single source of truth)
// =============================================================================
// Coarse permissions gate the ENDPOINTS; relationship scoping (teacher->their
// classes, student->enrolled, parent->their children) narrows the ROWS in the
// service layer, backstopped by RLS. A teacher having `class.read` does NOT mean
// they can read every class — only the ones they teach.
// =============================================================================

export const LMS_PERMISSIONS = {
  /** Read classes (rows further narrowed by relationship scoping). */
  CLASS_READ: "class.read",
  /** Create/edit classes. school_admin. */
  CLASS_WRITE: "class.write",
  /** Read class rosters / enrollments. teacher (own classes), school_admin. */
  ENROLLMENT_READ: "enrollment.read",
  /** Enroll/unenroll students, assign teachers. school_admin. */
  ENROLLMENT_WRITE: "enrollment.write",
  /** Link/unlink a guardian to a student. school_admin. */
  GUARDIAN_WRITE: "guardian.write",
  /** Manage the subject catalog + class subject/teacher assignments. principal / school_admin. */
  SUBJECT_MANAGE: "subject.manage",
  /** Initiate an end-of-session promotion batch (maker). principal / school_admin. */
  CLASS_PROMOTE: "class.promote",
  /** Approve a promotion batch (checker — a DIFFERENT person). school_admin. */
  CLASS_PROMOTE_APPROVE: "class.promote.approve",
  /** Read learning content (published; authors also see their own drafts). */
  CONTENT_READ: "lms.content.read",
  /** Create/edit/submit learning content. teacher (own class), school_admin. */
  CONTENT_WRITE: "lms.content.write",
  /** Approve/reject submitted content. PRINCIPAL only (process-maker approver). */
  CONTENT_APPROVE: "lms.content.approve",
  /** Take a published quiz. student. */
  QUIZ_ATTEMPT: "lms.quiz.attempt",
  /** Post a reply in a published forum thread. student + teaching staff. */
  FORUM_POST: "lms.forum.post",
} as const;

export type LmsPermission = (typeof LMS_PERMISSIONS)[keyof typeof LMS_PERMISSIONS];

/** Suggested role -> permission additions (spread into the foundation mapping). */
export const LMS_ROLE_PERMISSIONS = {
  school_admin: [
    LMS_PERMISSIONS.CLASS_READ,
    LMS_PERMISSIONS.CLASS_WRITE,
    LMS_PERMISSIONS.ENROLLMENT_READ,
    LMS_PERMISSIONS.ENROLLMENT_WRITE,
    LMS_PERMISSIONS.GUARDIAN_WRITE,
    LMS_PERMISSIONS.CONTENT_READ,
    LMS_PERMISSIONS.CONTENT_WRITE,
    LMS_PERMISSIONS.FORUM_POST,
  ],
  // Principal authors nothing by default but is the content APPROVER.
  principal: [LMS_PERMISSIONS.CONTENT_READ, LMS_PERMISSIONS.CONTENT_APPROVE],
  teacher: [
    LMS_PERMISSIONS.CLASS_READ,
    LMS_PERMISSIONS.ENROLLMENT_READ,
    LMS_PERMISSIONS.CONTENT_READ,
    LMS_PERMISSIONS.CONTENT_WRITE,
    LMS_PERMISSIONS.FORUM_POST,
  ],
  student: [
    LMS_PERMISSIONS.CLASS_READ,
    LMS_PERMISSIONS.CONTENT_READ,
    LMS_PERMISSIONS.QUIZ_ATTEMPT,
    LMS_PERMISSIONS.FORUM_POST,
  ],
  parent: [LMS_PERMISSIONS.CLASS_READ, LMS_PERMISSIONS.CONTENT_READ],
} as const;
