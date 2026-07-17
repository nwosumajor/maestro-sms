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

export const NOTIFICATION_TYPES = [
  "ATTENDANCE_ABSENCE",
  "GRADE_POSTED",
  "WORKFLOW_UPDATE",
  "INVOICE_ISSUED",
  "PAYMENT_RECEIVED",
  "DOCUMENT_AVAILABLE",
  "ANNOUNCEMENT",
  "GENERIC",
] as const;
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
