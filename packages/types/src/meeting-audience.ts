// =============================================================================
// Meeting audience — who a meeting is FOR
// =============================================================================
// The meetings page modelled one thing: a bookable 1:1 slot. Every parent in the
// school saw every open slot, with nothing saying which were meant for them —
// which is precisely why it reads as ambiguous. And a principal calling a whole-
// school or a year-group meeting had no way to express it at all.
//
// The fix is one field rather than a second model. A briefing IS a slot with a
// wider audience and a larger capacity; splitting them into two concepts would
// have doubled the screens, the permissions and the notification paths to say
// the same thing.
//
// THE RULE IS STORED, NOT THE RESOLVED LIST. Snapshotting "the 812 guardians of
// Senior Secondary" at creation time is wrong twice over: a pupil who enrols
// next week is silently left out, and one who leaves keeps getting invitations.
// Storing the rule means the audience is always current, and it is the reason
// nothing here fans out until a notification is actually sent.
// =============================================================================

export const MEETING_AUDIENCES = ["STUDENT", "SELECTED", "CLASS", "STAGE", "SCHOOL"] as const;
export type MeetingAudienceKind = (typeof MEETING_AUDIENCES)[number];

export interface MeetingAudience {
  kind: MeetingAudienceKind;
  /**
   * studentId, classId, or a SUBJECT_STAGES key. Null for SCHOOL and SELECTED.
   *
   * SELECTED is the one kind with no rule to derive a list from — a hand-picked
   * set of parents IS its own rule — so it stores them in `meeting_invitee`
   * instead. Every other kind stays derivable, and therefore stays current as
   * pupils come and go.
   */
  ref: string | null;
}

/**
 * Does this audience make the meeting an APPOINTMENT or a BRIEFING?
 *
 * The distinction is not cosmetic — it decides whether a capacity claim runs.
 * An appointment allocates a scarce thing (one teacher, one half-hour) and must
 * serialise; a briefing allocates nothing, and running a per-parent capacity
 * claim over it is how a whole-school meeting takes the system down:
 * `book()` COUNTs every existing booking inside each transaction, so 2,000
 * parents booking one slot is O(n²) reads all contending on the same rows.
 *
 * A hall either fits people or it does not, and that is not a per-parent
 * transaction.
 */
export function isAppointment(kind: MeetingAudienceKind): boolean {
  return kind === "STUDENT" || kind === "SELECTED";
}

/** What the audience is called on screen. The `names` map supplies the human
 *  label for an id the caller has already loaded — this never queries. */
export function describeAudience(
  a: MeetingAudience,
  names: { student?: string | null; class?: string | null; stage?: string | null } = {},
): string {
  switch (a.kind) {
    case "STUDENT":
      return names.student ? `${names.student}'s parents` : "One pupil's parents";
    case "SELECTED":
      return "Selected parents";
    case "CLASS":
      return names.class ? `All ${names.class} parents` : "One class's parents";
    case "STAGE":
      return names.stage ? `All ${names.stage} parents` : "One year group's parents";
    case "SCHOOL":
      return "All parents in the school";
  }
}

/** Why an audience cannot be used. Null when it can. */
export function meetingAudienceProblem(a: MeetingAudience): string | null {
  if (!(MEETING_AUDIENCES as readonly string[]).includes(a.kind)) {
    return `Audience must be one of ${MEETING_AUDIENCES.join(", ")}.`;
  }
  // SCHOOL is the only kind that takes no reference; every other kind is
  // meaningless without one, and a null ref would silently widen the invitation
  // to everybody — the exact mistake that must not be possible.
  if (a.kind === "SCHOOL") return a.ref ? "A whole-school meeting takes no class or pupil." : null;
  // SELECTED carries its people in meeting_invitee, not in `ref`.
  if (a.kind === "SELECTED") return a.ref ? "A selected-parents meeting takes no class or pupil." : null;
  if (!a.ref) return `A ${a.kind.toLowerCase()} meeting needs a ${a.kind === "STAGE" ? "year group" : a.kind.toLowerCase()}.`;
  return null;
}
