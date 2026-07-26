// Platform-feedback DTOs — any signed-in user → the platform owner.

/** COMPLAINT (something's wrong) or SUGGESTION (a new/improved function). */
export const FEEDBACK_KINDS = ["COMPLAINT", "SUGGESTION"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** OPEN → REVIEWED / RESOLVED / DISMISSED (set by the platform reviewer). */
export const FEEDBACK_STATUSES = ["OPEN", "REVIEWED", "RESOLVED", "DISMISSED"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** The sender's own view of a piece of feedback they submitted. */
export interface MyFeedbackDto {
  id: string;
  kind: string;
  subject: string;
  body: string;
  status: string;
  reviewNote: string | null;
  createdAt: Date;
}

/** The platform owner's cross-tenant view (adds who + which school sent it). */
export interface PlatformFeedbackDto {
  id: string;
  kind: string;
  subject: string;
  body: string;
  status: string;
  reviewNote: string | null;
  reviewedAt: Date | null;
  senderName: string;
  schoolName: string;
  createdAt: Date;
}
