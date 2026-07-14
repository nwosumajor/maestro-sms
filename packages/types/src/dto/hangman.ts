// Hangman (classroom letter-guessing) response DTOs. Server-form (Date fields are
// Date); the web consumes Serialized<…>.
//
// SECURITY (spec §9): the target word NEVER appears in a DTO while the round is
// live — each player sees only their MASKED word (revealed letters + "_"). The
// full word is exposed only once the round is FINISHED.

export type HangmanDifficultyDto = "EASY" | "MEDIUM" | "HARD";
export type HangmanGameStatusDto = "LOBBY" | "ACTIVE" | "FINISHED";
export type HangmanPlayerStatusDto = "PLAYING" | "WON" | "LOST";

/** A finisher on the leaderboard (solved the word). Public result. */
export interface HangmanFinisherDto {
  userId: string;
  displayName: string;
  rank: number;
  wrong: number;
}

/** The viewer's own board within the round. */
export interface HangmanSelfDto {
  playerId: string;
  /** The word MASKED for this player: revealed letters + "_" for the rest. */
  masked: string;
  /** Letters guessed so far (upper-case). */
  guessed: string[];
  wrong: number;
  livesRemaining: number;
  status: HangmanPlayerStatusDto;
  rank: number | null;
}

/** One hangman round, redacted for the requesting viewer. */
export interface HangmanGameDto {
  id: string;
  classId: string;
  difficulty: HangmanDifficultyDto;
  status: HangmanGameStatusDto;
  /** Word length so the UI can render the right number of slots. */
  wordLength: number;
  lives: number;
  participantCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  isHost: boolean;
  /** The viewer's own board, or null if they haven't joined. */
  you: HangmanSelfDto | null;
  /** Solvers, ranked (fewest wrong, earliest). */
  leaderboard: HangmanFinisherDto[];
  winnerUserId: string | null;
  /** The full word — populated ONLY when the round is FINISHED. */
  word: string | null;
}

/** Result of one letter guess (returned to the guessing player). */
export interface HangmanGuessResultDto {
  hit: boolean;
  masked: string;
  wrong: number;
  livesRemaining: number;
  status: HangmanPlayerStatusDto;
}

/** A joinable/active round in discovery lists. */
export interface HangmanSummaryDto {
  id: string;
  classId: string;
  className: string | null;
  difficulty: HangmanDifficultyDto;
  status: HangmanGameStatusDto;
  participantCount: number;
  joined: boolean;
  isHost: boolean;
  createdAt: Date;
}
