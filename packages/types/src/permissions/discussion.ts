// Discussion Hub — topic groups, posts, comments, admin moderation.
export const DISCUSSION_PERMISSIONS = {
  /** View groups + post / comment. Members of the audience (everyone in school). */
  DISCUSSION_PARTICIPATE: "discussion.participate",
  /** Create groups + delete (moderate) any post/comment. principal / school_admin. */
  DISCUSSION_MODERATE: "discussion.moderate",
} as const;
export type DiscussionPermission = (typeof DISCUSSION_PERMISSIONS)[keyof typeof DISCUSSION_PERMISSIONS];
