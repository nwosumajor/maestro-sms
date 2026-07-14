// Typing Race (classroom typing game) response DTOs. Server-form (Date fields are
// Date); the web consumes Serialized<…>. The passage is NOT a secret — players
// type it — so it is always present in the view.

export type TypingDifficultyDto = "EASY" | "MEDIUM" | "HARD";
export type TypingRaceStatusDto = "LOBBY" | "ACTIVE" | "FINISHED";

/** A finisher on the leaderboard. Public result (metrics, by display name). */
export interface TypingFinisherDto {
  userId: string;
  displayName: string;
  rank: number;
  netWpm: number;
  accuracy: number;
  finished: boolean;
  /** Correctly-typed characters (for a progress bar). */
  progress: number;
}

/** The viewer's own progress within the race. */
export interface TypingSelfDto {
  racerId: string;
  netWpm: number;
  accuracy: number;
  progress: number;
  finished: boolean;
  rank: number | null;
}

/** One typing race, for the requesting viewer. */
export interface TypingRaceDto {
  id: string;
  classId: string;
  difficulty: TypingDifficultyDto;
  status: TypingRaceStatusDto;
  /** The passage to type (shown to everyone). */
  passage: string;
  /** Target WPM at/above which the result is "excellent" (for the UI). */
  targetWpm: number;
  participantCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  isHost: boolean;
  /** The viewer's own progress, or null if they haven't joined. */
  you: TypingSelfDto | null;
  /** All racers ranked (live). */
  leaderboard: TypingFinisherDto[];
  winnerUserId: string | null;
}

/** Result of one progress update (returned to the racer). */
export interface TypingProgressResultDto {
  netWpm: number;
  accuracy: number;
  progress: number;
  finished: boolean;
  rank: number | null;
}

/** A joinable/active race in discovery lists. */
export interface TypingRaceSummaryDto {
  id: string;
  classId: string;
  className: string | null;
  difficulty: TypingDifficultyDto;
  status: TypingRaceStatusDto;
  participantCount: number;
  joined: boolean;
  isHost: boolean;
  createdAt: Date;
}
