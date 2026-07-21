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
] as const;

/** The noisy, opt-out-able types offered as per-type mute toggles in the UI.
 *  (Anything not listed here is still delivered per the channel toggles; this
 *  is just the curated set worth surfacing as checkboxes.) */
export const MUTABLE_NOTIFICATION_TYPES: { type: string; label: string }[] = [
  { type: "ANNOUNCEMENT", label: "School announcements" },
  { type: "FEE_REMINDER", label: "Fee reminders" },
  { type: "GRADE_PUBLISH", label: "Grade publications" },
  { type: "LMS_CONTENT_PUBLISH", label: "New lessons & materials" },
  { type: "ATTENDANCE_ABSENCE", label: "Attendance alerts" },
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
  const muted = !essential && pref.mutedTypes.includes(type);
  if (muted) return [];
  return requested.filter((c) => {
    if (c === "EMAIL") return pref.emailEnabled;
    if (c === "SMS") return pref.smsEnabled;
    if (c === "WHATSAPP") return pref.whatsappEnabled;
    return true; // unknown channel — leave as-is
  });
}
