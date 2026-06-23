// Dead & Wounded game response DTOs (platform spec §10). Server-form (Date
// fields are Date; the web consumes Serialized<…>).
//
// SECURITY (spec §9): NO DTO here carries a player's secret. Secrets live
// server-side only (GamePlayer.secret) and are never serialized to any client —
// not even the game owner's. The score (`dead`/`wounded`) is the only thing a
// guess reveals.

export type GameModeDto = "DUEL" | "RING" | "RACE" | "LEAGUE_MATCH" | "KNOCKOUT_MATCH" | "ULTIMATE";
export type GameStatusDto = "LOBBY" | "SETUP" | "ACTIVE" | "FINISHED" | "ABANDONED";
export type GameOutcomeDto = "WON" | "LOST" | "ELIMINATED" | "FORFEIT";

/** The score of one guess. */
export interface DeadWoundedDto {
  dead: number;
  wounded: number;
}

/** A recorded guess (a public move — value + score, never a secret). */
export interface GameGuessDto {
  id: string;
  guesserId: string;
  targetId: string;
  value: string;
  dead: number;
  wounded: number;
  createdAt: Date;
}

/** A participant, by display name (never PII beyond the in-school name). */
export interface GamePlayerDto {
  playerId: string;
  userId: string;
  displayName: string;
  ready: boolean;
  eliminated: boolean;
  guessCount: number;
}

/** The redacted game view a client receives. */
export interface GameDto {
  id: string;
  mode: GameModeDto;
  difficultyLength: number;
  status: GameStatusDto;
  currentTurnPlayerId: string | null;
  winnerPlayerId: string | null;
  /** The viewer's own GamePlayer id, if they are a participant. */
  you: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  players: GamePlayerDto[];
  guesses: GameGuessDto[];
}

/** A per-participant result row (spec §10 GameResult). */
export interface GameResultDto {
  userId: string;
  rank: number;
  guessCount: number;
  outcome: GameOutcomeDto;
}

/** A lobby game waiting for an opponent (open-games list). */
export interface OpenGameDto {
  id: string;
  difficultyLength: number;
  createdAt: Date;
  hostDisplayName: string;
}
