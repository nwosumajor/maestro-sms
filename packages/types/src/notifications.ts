import type { NotificationTypeValue } from "./permissions/notifications";

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
export const ESSENTIAL_NOTIFICATION_TYPES: readonly NotificationTypeValue[] = [
  "PAYMENT_RECEIVED",
  "INVOICE_ISSUED",
  "BILLING",
  "OPERATOR_ALERT",
  // "ADMIN_APPOINTMENT" was here and is a WORKFLOW REQUEST type, never a
  // notification — the appointment reaches its approver as WORKFLOW_UPDATE.
  // A fifth string in these lists naming nothing, and the one the compiler
  // found rather than a person.
  // The type the intake actually writes is ONBOARDING_REQUEST. This said
  // "ONBOARDING", which is an HR CHECKLIST type and no notification has ever
  // carried it — so the protection named a row that does not exist.
  "ONBOARDING_REQUEST",
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
export const MUTABLE_NOTIFICATION_TYPES: { type: NotificationTypeValue; label: string }[] = [
  { type: "ANNOUNCEMENT", label: "School announcements" },
  { type: "FEE_REMINDER", label: "Fee reminders" },
  { type: "LMS_CONTENT_PUBLISH", label: "New lessons & materials" },
  { type: "ATTENDANCE_LATE", label: "Late-arrival alerts" },
  { type: "DOCUMENT_AVAILABLE", label: "New documents" },
];

// FOUR OF THE EIGHT CHECKBOXES HERE GOVERNED NOTHING, and the screen gave no
// sign of it — a control that appears to work and does not is worse than one
// that is missing, because the reader stops looking for the real switch.
//
//   GRADE_PUBLISH       a WORKFLOW request type. Publishing grades enqueues no
//                       notification at all; the guardian hears through the
//                       report card, which is DOCUMENT_AVAILABLE and already
//                       has its own checkbox two lines up.
//   LMS_CONTENT_PUBLISH also a workflow type — but here the promise was worth
//                       keeping rather than deleting, because "new lessons"
//                       genuinely is a thing a parent might want quiet. The
//                       EMITTER was the half that was wrong: it sent
//                       ANNOUNCEMENT, so the only way to silence new-lesson
//                       alerts was to silence every school announcement too.
//                       It now sends LMS_CONTENT_PUBLISH.
//   LEAGUE              a COMPETITION type. The game module enqueues nothing.
//   ALUMNI_BROADCAST    the alumni broadcast deliberately bypasses the
//                       notification funnel entirely — "an alumnus has left by
//                       definition and a notification is addressed to an account
//                       they can no longer open" — and emails directly. So this
//                       switch could never have stopped the emails a leaver
//                       actually receives, which is the one thing somebody
//                       ticking it would expect.
//
// NOTHING WAS ADDED IN THEIR PLACE, deliberately. Widening what a parent may
// switch off is a PRODUCT decision about what a school is willing to let a
// family miss — not a defect fix, and not mine to make. An earlier draft of this
// change added MEETING and TRANSPORT_ROUTE_CHANGE here on the reasoning that
// they are emitted and non-essential, and `a-guardian-cannot-mute-an-absence`
// caught it: that suite pins, by name, that a type the school never made
// optional is delivered even when a mute request names it. Removing four
// checkboxes that governed nothing is a fix; adding two that would govern
// something is a feature, and it needs somebody to ask for it.

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
