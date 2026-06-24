// Dead & Wounded League/Knockout response DTOs (platform spec §6/§10, step 4).
// Server-form (Date fields are Date); the web consumes Serialized<…>.
//
// SECURITY (spec §9): as with the duel DTOs, NOTHING here carries a player's
// secret. A competition view exposes only standings, match metadata, and the
// in-school display names of participants — never PII beyond the name.

export type CompetitionTypeDto = "LEAGUE" | "KNOCKOUT" | "RACE_TOURNAMENT" | "ULTIMATE";
export type CompetitionStatusDto = "DRAFT" | "ACTIVE" | "FINISHED" | "CANCELLED";

/** A competition summary row (listing). */
export interface CompetitionDto {
  id: string;
  type: CompetitionTypeDto;
  name: string;
  difficultyLength: number;
  status: CompetitionStatusDto;
  startAt: Date;
  endAt: Date;
  currentRound: number;
  participantCount: number;
  createdAt: Date;
}

/** One leaderboard row within a competition (spec §10 Standing). */
export interface StandingDto {
  userId: string;
  displayName: string;
  points: number;
  wins: number;
  losses: number;
  totalGuesses: number;
  rank: number | null;
  roundNumber: number | null;
  eliminated: boolean;
}

/** A match (2-player game) belonging to a competition — metadata only. */
export interface CompetitionMatchDto {
  gameId: string;
  roundNumber: number | null;
  status: "LOBBY" | "SETUP" | "ACTIVE" | "FINISHED" | "ABANDONED";
  deadlineAt: Date | null;
  finishedAt: Date | null;
  /** The two seated players (display names), in join order. */
  players: { userId: string; displayName: string }[];
  /** The winning player's userId once finished, else null. */
  winnerUserId: string | null;
}

/** Full competition view: summary + standings + matches. */
export interface CompetitionDetailDto extends CompetitionDto {
  standings: StandingDto[];
  matches: CompetitionMatchDto[];
}
