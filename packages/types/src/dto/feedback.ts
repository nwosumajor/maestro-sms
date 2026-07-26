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

/**
 * Aggregate triage counts for the owner's inbox — one grouped query, so the
 * header stays cheap no matter how many rows exist. Lets the owner see the shape
 * of 5000/day at a glance and filter rather than scroll.
 */
export interface FeedbackStatsDto {
  total: number;
  open: number;
  reviewed: number;
  resolved: number;
  dismissed: number;
  complaints: number;
  suggestions: number;
  /** New OPEN feedback in the last 24h — the "needs attention now" signal. */
  last24h: number;
}

/** Max ids a single bulk-review call may touch (bounded work). */
export const FEEDBACK_BULK_MAX = 200;
