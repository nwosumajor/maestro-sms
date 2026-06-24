// Dead & Wounded Ultimate (cross-school) DTOs (platform spec §7/§10, step 8).
// Server-form (Date fields are Date); the web consumes Serialized<…>.
//
// SECURITY (spec §7/§9): NOTHING here carries student PII. The leaderboard shows
// a HANDLE (never a real name) + the SCHOOL NAME (institution, explicitly allowed
// for grouping) + scores. The per-entry target secret is server-only and never
// serialized. The opaque participant id is shown only to mark the viewer's own row.

export type UltimateStatusDto = "DRAFT" | "ACTIVE" | "FINISHED" | "CANCELLED";

/** A cross-school competition (super_admin-created). */
export interface UltimateCompetitionDto {
  id: string;
  name: string;
  difficultyLength: number;
  status: UltimateStatusDto;
  startAt: Date;
  endAt: Date;
  /** Has the VIEWER's school enrolled into this competition (tier-1)? */
  schoolEnrolled: boolean;
  /** Has the VIEWER already entered (joined) this competition? */
  entered: boolean;
}

/** The caller's OWN entry (never exposes the secret). */
export interface UltimateEntryDto {
  competitionId: string;
  handle: string;
  status: "ACTIVE" | "FINISHED";
  guessCount: number;
  elapsedMs: number | null;
  finishedAt: Date | null;
  /** The caller's rank on the leaderboard once finished, else null. */
  rank: number | null;
}

/** One cross-school leaderboard row — pseudonymous, no PII. */
export interface UltimateLeaderboardRowDto {
  handle: string;
  schoolName: string;
  guessCount: number;
  elapsedMs: number;
  rank: number;
  /** True for the viewer's own row (matched via their private entry link). */
  isYou: boolean;
}

/** The cross-school leaderboard (finishers, ranked by §7 metric). */
export interface UltimateLeaderboardDto {
  competitionId: string;
  difficultyLength: number;
  participantCount: number;
  rows: UltimateLeaderboardRowDto[];
}
