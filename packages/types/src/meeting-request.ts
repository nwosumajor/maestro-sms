// =============================================================================
// Parent-initiated meeting requests
// =============================================================================
// Until now a parent could only BOOK a slot a teacher had already opened. That
// is a pull model: it works when the teacher anticipated the need, and offers a
// parent nothing when they did not.
//
// THE APPROVER IS THE TEACHER, not the principal. The teacher owns the time
// being asked for; routing every request through leadership adds a decision by
// somebody who will not attend, and in a school of any size the queue becomes
// the reason meetings stop happening — parents go back to catching staff at the
// gate, which is worse for the record than the thing approval was protecting.
// Maker-checker in this product is for money and irreversible privilege; a
// pastoral conversation is not in that class.
//
// Leadership gets VISIBILITY (they can see every request) and an EXCEPTION path
// (a decline escalates), plus an explicit per-school opt-in when a school
// genuinely wants to gate every one.
// =============================================================================

/**
 * PENDING_APPROVAL exists only for schools that switched approval ON. Every
 * other school's request starts at PENDING_TEACHER — one decision, by the
 * person whose diary it is.
 */
export const MEETING_REQUEST_STATUSES = [
  "PENDING_APPROVAL",
  "PENDING_TEACHER",
  "ACCEPTED",
  "DECLINED",
  "CANCELLED",
] as const;
export type MeetingRequestStatus = (typeof MEETING_REQUEST_STATUSES)[number];

export const MEETING_REQUEST_STATUS_LABELS: Record<MeetingRequestStatus, string> = {
  PENDING_APPROVAL: "Awaiting the school's approval",
  PENDING_TEACHER: "Waiting for the teacher",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  CANCELLED: "Withdrawn",
};

/**
 * Why the parent is asking. This is not decoration: a CONCERN routes to
 * leadership whatever the school's approval setting, because "I want to raise a
 * concern about my child" addressed to the person it may be about is the one
 * routing this feature must not get wrong.
 */
export const MEETING_REQUEST_TOPICS = ["PROGRESS", "WELLBEING", "ATTENDANCE", "CONCERN", "OTHER"] as const;
export type MeetingRequestTopic = (typeof MEETING_REQUEST_TOPICS)[number];

export const MEETING_REQUEST_TOPIC_LABELS: Record<MeetingRequestTopic, string> = {
  PROGRESS: "Progress in a subject",
  WELLBEING: "Wellbeing or behaviour",
  ATTENDANCE: "Attendance",
  CONCERN: "A concern I want to raise",
  OTHER: "Something else",
};

/** A CONCERN always involves leadership, whatever the school's setting. */
export function needsLeadership(topic: string, schoolRequiresApproval: boolean): boolean {
  return topic === "CONCERN" || schoolRequiresApproval;
}

/** Where a new request starts. */
export function initialRequestStatus(topic: string, schoolRequiresApproval: boolean): MeetingRequestStatus {
  return needsLeadership(topic, schoolRequiresApproval) ? "PENDING_APPROVAL" : "PENDING_TEACHER";
}

/** Whether this status still awaits somebody. Used for the "open" filters and
 *  for the staleness sweep, so both agree on what "outstanding" means. */
export function isOpenRequest(status: string): boolean {
  return status === "PENDING_APPROVAL" || status === "PENDING_TEACHER";
}

/**
 * A request nobody has answered is the failure mode this design has to own: the
 * teacher is the only approver, so if they never look, the parent waits for
 * ever with no signal. After this many days it surfaces to leadership.
 */
export const MEETING_REQUEST_STALE_DAYS = 3;

export interface MeetingRequestDto {
  id: string;
  studentId: string;
  studentName: string;
  parentId: string;
  parentName: string;
  teacherId: string;
  teacherName: string;
  topic: string;
  topicLabel: string;
  note: string | null;
  status: MeetingRequestStatus;
  statusLabel: string;
  /** Set once accepted — the slot that was opened, so the parent can join. */
  slotId: string | null;
  decisionNote: string | null;
  decidedByName: string | null;
  /** True when it has been waiting longer than MEETING_REQUEST_STALE_DAYS. */
  stale: boolean;
  createdAt: Date;
  updatedAt: Date;
}
