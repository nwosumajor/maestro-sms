// Dead & Wounded Class Race response DTOs (platform spec §5, step 5).
// Server-form (Date fields are Date); the web consumes Serialized<…>.
//
// SECURITY (spec §9): the race's shared target secret NEVER appears in any DTO
// here — it lives server-only on Game.targetSecret. A racer sees ONLY their own
// guesses/feedback; other students' in-progress guesses are never exposed. The
// leaderboard shows finishers (the public result), by display name only.

export type RaceStatusDto = "LOBBY" | "ACTIVE" | "FINISHED" | "ABANDONED";

/** One racer's own guess (value + score). Returned ONLY to that racer. */
export interface RaceGuessDto {
  value: string;
  dead: number;
  wounded: number;
  createdAt: Date;
}

/** A finisher on the race leaderboard (cracked the target). Public result. */
export interface RaceFinisherDto {
  userId: string;
  displayName: string;
  rank: number;
  guessCount: number;
  elapsedMs: number;
}

/** A single class race, redacted for the requesting viewer. */
export interface RaceDto {
  id: string;
  classId: string | null;
  difficultyLength: number;
  status: RaceStatusDto;
  startedAt: Date | null;
  finishedAt: Date | null;
  participantCount: number;
  /** The viewer's GamePlayer id if they joined this race, else null. */
  you: string | null;
  /** The viewer's OWN guesses (empty if they aren't a participant). */
  yourGuesses: RaceGuessDto[];
  /** The viewer's own finish, once they crack the target (else null). */
  yourFinish: { rank: number; guessCount: number; elapsedMs: number } | null;
  /** Top finishers (ranked); the winners are ranks 1–3 (spec §5). */
  leaderboard: RaceFinisherDto[];
  /** The 1st-place finisher's userId once decided, else null. */
  winnerUserId: string | null;
  /** Part of a cross-class race tournament, if any. */
  tournamentId: string | null;
}

/** A race in the discover/join list — summary only (no guesses, no target). */
export interface RaceSummaryDto {
  id: string;
  classId: string | null;
  className: string | null;
  difficultyLength: number;
  status: RaceStatusDto;
  startedAt: Date | null;
  participantCount: number;
  /** True if the viewer has already joined this race. */
  joined: boolean;
  /** Part of a cross-class tournament, if any. */
  tournamentId: string | null;
  createdAt: Date;
}

/** A combined / per-class race-tournament standing row (spec §5 normalized metric). */
export interface RaceStandingDto {
  userId: string;
  displayName: string;
  classRaceId: string;
  guessCount: number;
  elapsedMs: number;
  rank: number;
}

/** A cross-class race tournament: per-class races + combined standings (§5). */
export interface RaceTournamentDto {
  id: string;
  name: string;
  difficultyLength: number;
  status: "DRAFT" | "ACTIVE" | "FINISHED" | "CANCELLED";
  startAt: Date;
  endAt: Date;
  /** The class races that make up the tournament (each has its OWN target). */
  classRaceIds: string[];
  /** Combined standings across all class races (time-independent metric). */
  combined: RaceStandingDto[];
  /** Per-class standings, kept alongside the combined board (§5). */
  perClass: { classRaceId: string; classId: string | null; standings: RaceStandingDto[] }[];
}
