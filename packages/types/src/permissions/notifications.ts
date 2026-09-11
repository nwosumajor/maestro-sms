// =============================================================================
// Notifications — permission constants (single source of truth)
// =============================================================================
// READ is self-scoped (every user reads only their OWN inbox) — granted broadly.
// SEND is staff-only and relationship-scoped in the service (a teacher may only
// notify their own students / those students' guardians; school staff anyone in
// the tenant). System producers (e.g. Attendance) call the service directly and
// are not gated by SEND.
// =============================================================================

export const NOTIFICATION_CHANNELS = ["EMAIL", "SMS", "PUSH", "WHATSAPP"] as const;
export type NotificationChannelValue = (typeof NOTIFICATION_CHANNELS)[number];

/** Channels that consume prepaid message credits (1 credit per delivery). */
export const CREDIT_CHANNELS: readonly NotificationChannelValue[] = ["SMS", "WHATSAPP"] as const;

/** Prepaid message-credit bundles a school can buy (NGN kobo). Priced with
 *  margin over Nigerian SMS gateway cost (~₦4–6/SMS); WhatsApp debits the same
 *  credit. One constant drives the buy screen AND checkout — no drift. */
export const MESSAGE_CREDIT_BUNDLES = [
  { id: "S", credits: 200, priceMinor: 300_000 }, // ₦3,000 (₦15/msg)
  { id: "M", credits: 1_000, priceMinor: 1_200_000 }, // ₦12,000 (₦12/msg)
  { id: "L", credits: 5_000, priceMinor: 5_000_000 }, // ₦50,000 (₦10/msg)
] as const;
export type MessageCreditBundle = (typeof MESSAGE_CREDIT_BUNDLES)[number];

/**
 * Warn the school while it can still act.
 *
 * Running out is invisible from inside the school: the in-app inbox and email
 * still go out, so nothing looks broken — only the SMS and WhatsApp copies stop,
 * and the first anyone hears of it is a parent asking why they were not told
 * their child was absent. A threshold that is only reached at zero is a
 * threshold that warns nobody in time.
 */
export const MESSAGE_CREDIT_LOW_THRESHOLD = 50;

/**
 * EVERY notification type the platform emits — the ONE list, and it GATES.
 *
 * This was nine entries with a note saying it was "INCOMPLETE and does not gate
 * anything", because `NotificationInput.type` was `NotificationTypeValue |
 * string`. Three other lists then grew beside it — the mute screen, the
 * essential set, and the inbox filter dropdown in the web — each hand-kept, none
 * tied to what any emitter actually writes. Measured on a parent three years in
 * with 3,320 notifications:
 *
 *   - the inbox filter offered 12 categories; TWO of them (`GRADE_POSTED`,
 *     `ONBOARDING`) are emitted by nothing, anywhere, and return nothing for every user
 *     forever — `GRADE_POSTED` appeared in no file in apps/api/src at all, and
 *     `ONBOARDING` is an HR CHECKLIST type;
 *   - 2,213 of that parent's 3,320 notifications (67%) could not be reached by
 *     any option in the menu, because the types they carry were never offered;
 *   - FOUR of the eight mute checkboxes governed nothing.
 *
 * The `| string` is gone, so this union is now enforced by the COMPILER at every
 * emitter — the same spine the permission constants use, where a typo'd string
 * fails the build rather than silently creating a category nobody can filter to
 * and nobody can mute.
 *
 * ADDING A TYPE: add it here, and give it a label in NOTIFICATION_TYPE_LABELS so
 * the inbox can offer it. Both are checked by
 * `every-notification-type-can-be-found.spec.ts`.
 */
export const NOTIFICATION_TYPES = [
  "ANNOUNCEMENT",
  "ATTENDANCE_ABSENCE",
  "ATTENDANCE_LATE",
  "ATTENDANCE_REGISTER_DUE",
  "BILLING",
  "DISCIPLINE_CASE",
  "DISCIPLINE_OUTCOME",
  "DOCUMENT_AVAILABLE",
  "FEEDBACK_REPLY",
  "FEE_REMINDER",
  "GENERIC",
  "HOSTEL",
  "INTEGRITY_SIGNAL",
  "INVOICE_ISSUED",
  "LMS_CONTENT_PUBLISH",
  "MEETING",
  "ONBOARDING_REQUEST",
  "OPERATOR_ALERT",
  "PAYMENT_RECEIVED",
  "SCHOLARSHIP",
  "SIS_PROFILE",
  "TRANSPORT",
  "TRANSPORT_ROUTE_CHANGE",
  "WORKFLOW_UPDATE",
] as const;

/**
 * What each type is called on screen.
 *
 * The inbox filter DERIVES its menu from this, rather than keeping a thirteenth
 * hand-written copy of the same strings in the web tier.
 */
export const NOTIFICATION_TYPE_LABELS: Record<(typeof NOTIFICATION_TYPES)[number], string> = {
  ANNOUNCEMENT: "Announcements",
  ATTENDANCE_ABSENCE: "Absence alerts",
  ATTENDANCE_LATE: "Late-arrival alerts",
  ATTENDANCE_REGISTER_DUE: "Register reminders",
  BILLING: "Billing",
  DISCIPLINE_CASE: "Discipline cases",
  DISCIPLINE_OUTCOME: "Discipline outcomes",
  DOCUMENT_AVAILABLE: "New documents",
  FEEDBACK_REPLY: "Feedback replies",
  FEE_REMINDER: "Fee reminders",
  GENERIC: "Other",
  HOSTEL: "Hostel",
  INTEGRITY_SIGNAL: "Integrity signals",
  INVOICE_ISSUED: "Invoices issued",
  LMS_CONTENT_PUBLISH: "New lessons & materials",
  MEETING: "Meetings",
  ONBOARDING_REQUEST: "Onboarding requests",
  OPERATOR_ALERT: "Operator alerts",
  PAYMENT_RECEIVED: "Payments received",
  SCHOLARSHIP: "Scholarships",
  SIS_PROFILE: "Student records",
  TRANSPORT: "Transport",
  TRANSPORT_ROUTE_CHANGE: "Route changes",
  WORKFLOW_UPDATE: "Approvals",
};

export type NotificationTypeValue = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_PERMISSIONS = {
  /** Read / mark-read one's OWN inbox. */
  NOTIFICATION_READ: "notification.read",
  /** Send a notification to another user (relationship-scoped in the service). */
  NOTIFICATION_SEND: "notification.send",
} as const;

export type NotificationPermission =
  (typeof NOTIFICATION_PERMISSIONS)[keyof typeof NOTIFICATION_PERMISSIONS];

/** Suggested role -> permission additions (spread into the foundation mapping). */
export const NOTIFICATION_ROLE_PERMISSIONS = {
  principal: [NOTIFICATION_PERMISSIONS.NOTIFICATION_READ, NOTIFICATION_PERMISSIONS.NOTIFICATION_SEND],
  school_admin: [NOTIFICATION_PERMISSIONS.NOTIFICATION_READ, NOTIFICATION_PERMISSIONS.NOTIFICATION_SEND],
  board: [NOTIFICATION_PERMISSIONS.NOTIFICATION_READ],
  teacher: [NOTIFICATION_PERMISSIONS.NOTIFICATION_READ, NOTIFICATION_PERMISSIONS.NOTIFICATION_SEND],
  accountant: [NOTIFICATION_PERMISSIONS.NOTIFICATION_READ],
  hr_clerk: [NOTIFICATION_PERMISSIONS.NOTIFICATION_READ],
  student: [NOTIFICATION_PERMISSIONS.NOTIFICATION_READ],
  parent: [NOTIFICATION_PERMISSIONS.NOTIFICATION_READ],
} as const;

/**
 * The 403 a suspended school gets, told apart from an ordinary permission 403.
 *
 * Shared because BOTH sides must agree on it: the API guard raises it on every
 * authenticated request from a school the operator has switched off, and the web
 * turns it into a page that says so instead of an app full of empty panels.
 * A literal on either side would be a contract nobody checks.
 */
export const SCHOOL_SUSPENDED_CODE = "SCHOOL_SUSPENDED";
