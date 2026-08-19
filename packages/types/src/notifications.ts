// Notification delivery preferences. The in-app inbox is ALWAYS created (it is
// how the app surfaces notifications); preferences only gate the EXTERNAL
// channels (email / SMS / WhatsApp).

/** External channels a preference can toggle (PUSH is not user-metered here). */
export const PREFERENCE_CHANNELS = ["EMAIL", "SMS", "WHATSAPP"] as const;
export type NotificationPrefChannel = (typeof PREFERENCE_CHANNELS)[number];

/** Essential types cannot be MUTED per-type (mute is ignored for them) — they
 *  carry security or money-critical information. Channel toggles still apply:
 *  a user who turns EMAIL off entirely gets none, but the in-app inbox always
 *  has it. */
export const ESSENTIAL_NOTIFICATION_TYPES = [
  "PAYMENT_RECEIVED",
  "INVOICE_ISSUED",
  "BILLING",
  "OPERATOR_ALERT",
  "ADMIN_APPOINTMENT",
  "ONBOARDING",
  // A recorded disciplinary outcome concerning a child. ESSENTIAL deliberately:
  // a guardian must not be able to mute, by accident or otherwise, the message
  // telling them a sanction was recorded against their child's name.
  "DISCIPLINE_OUTCOME",
  // The child is not at school and nobody has said why. By the same reasoning as
  // the line above — and more so, because this is the message through which a
  // family learns their child never arrived. It used to share one type with
  // "arrived late", so muting the punctuality nudge muted this as well; they are
  // now separate types precisely so that choice does not have to be made.
  "ATTENDANCE_ABSENCE",
] as const;

/**
 * The types a recipient may switch off, and the ONLY ones.
 *
 * This was documented as "just the curated set worth surfacing as checkboxes",
 * with the mute column accepting any string the client sent — so the list
 * described the UI rather than bounding the behaviour, and every non-essential
 * type the platform sends (a hostel notice, a scholarship decision, a change to
 * a child's SIS record) could be muted by a request that simply named it.
 *
 * It is now the boundary: `allowedChannels` honours a mute only for a type on
 * this list, and the endpoint refuses one that is not. A type belongs here
 * because the school has decided it is optional, not because nobody thought
 * about it.
 */
export const MUTABLE_NOTIFICATION_TYPES: { type: string; label: string }[] = [
  { type: "ANNOUNCEMENT", label: "School announcements" },
  { type: "FEE_REMINDER", label: "Fee reminders" },
  { type: "GRADE_PUBLISH", label: "Grade publications" },
  { type: "LMS_CONTENT_PUBLISH", label: "New lessons & materials" },
  { type: "ATTENDANCE_LATE", label: "Late-arrival alerts" },
  { type: "DOCUMENT_AVAILABLE", label: "New documents" },
  { type: "LEAGUE", label: "Game & league updates" },
  { type: "ALUMNI_BROADCAST", label: "Alumni broadcasts" },
];

export interface NotificationPreferenceDto {
  emailEnabled: boolean;
  smsEnabled: boolean;
  whatsappEnabled: boolean;
  /** Notification types the user has muted on external channels. */
  mutedTypes: string[];
}

/** Pure: given a recipient's preference and a notification's type + requested
 *  external channels, return the channels that should actually be delivered.
 *  Essential types ignore per-type mute (but not channel toggles). */
export function allowedChannels(
  pref: NotificationPreferenceDto | null,
  type: string,
  requested: readonly string[],
): string[] {
  if (!pref) return [...requested]; // no preference row => default: deliver all
  const essential = (ESSENTIAL_NOTIFICATION_TYPES as readonly string[]).includes(type);
  // A mute counts only for a type that is actually mutable. Enforced HERE as
  // well as at the endpoint because this is the one function every delivery
  // passes through: rows written before the endpoint validated anything, or by
  // any future caller, cannot suppress a message the school never made optional.
  const mutable = MUTABLE_NOTIFICATION_TYPES.some((m) => m.type === type);
  const muted = !essential && mutable && pref.mutedTypes.includes(type);
  if (muted) return [];
  return requested.filter((c) => {
    if (c === "EMAIL") return pref.emailEnabled;
    if (c === "SMS") return pref.smsEnabled;
    if (c === "WHATSAPP") return pref.whatsappEnabled;
    return true; // unknown channel — leave as-is
  });
}
