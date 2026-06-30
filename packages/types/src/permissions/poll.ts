// Polling System — anonymous opinion polls.
export const POLL_PERMISSIONS = {
  /** Create / close polls + view results. principal / school_admin / teacher. */
  POLL_MANAGE: "poll.manage",
  /** View open polls and cast an anonymous vote. Members of the audience. */
  POLL_VOTE: "poll.vote",
} as const;
export type PollPermission = (typeof POLL_PERMISSIONS)[keyof typeof POLL_PERMISSIONS];
