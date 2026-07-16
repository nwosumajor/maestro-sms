// Live Quiz (Kahoot-style, curriculum-themed) response DTOs. Server-form (Date
// fields are Date); the web consumes Serialized<…>.
//
// SECURITY (spec §9): a question's correct `answerIndex` is NEVER present in a
// player-facing DTO while the question is live — it is populated only once the
// question has closed (time elapsed) or the session has ENDED. The service is
// the sole authority that decides when to reveal.

export type QuizThemeDto = "GEOGRAPHY" | "SCIENCE" | "ART" | "LITERATURE" | "GENERAL";
export type QuizDifficultyDto = "EASY" | "MEDIUM" | "HARD";
export type LiveQuizStatusDto = "LOBBY" | "ACTIVE" | "ENDED";

/** A quiz in the author's library (list/pick when hosting). */
export interface LiveQuizSummaryDto {
  id: string;
  title: string;
  theme: QuizThemeDto;
  difficulty: QuizDifficultyDto;
  questionCount: number;
  createdAt: Date;
}

/** A question as an AUTHOR/host sees it — includes the correct answer. */
export interface LiveQuizAuthorQuestionDto {
  orderIndex: number;
  prompt: string;
  choices: string[];
  answerIndex: number;
}

/** Full quiz for editing/management (host/staff only — carries answers). */
export interface LiveQuizDto {
  id: string;
  title: string;
  theme: QuizThemeDto;
  difficulty: QuizDifficultyDto;
  questions: LiveQuizAuthorQuestionDto[];
  createdAt: Date;
}

/** The live question as a PLAYER sees it. `answerIndex` is null until reveal. */
export interface LiveQuizQuestionPublicDto {
  index: number;
  prompt: string;
  choices: string[];
  timeLimitSeconds: number;
  startedAt: Date | null;
  /** Correct choice — populated ONLY after the question closes / session ends. */
  answerIndex: number | null;
}

/** One row on the live leaderboard (public result, by display name). */
export interface LiveQuizLeaderRowDto {
  userId: string;
  displayName: string;
  score: number;
  correct: number;
  rank: number;
}

/** The viewer's own live state within a session. */
export interface LiveQuizSelfDto {
  participantId: string;
  score: number;
  streak: number;
  /** Whether the viewer has answered the CURRENT question. */
  answeredCurrent: boolean;
  /** Correctness of the viewer's answer to the current question, if answered. */
  currentCorrect: boolean | null;
  /** The viewer's rank on the SAME ordering the leaderboard shows (1 = top),
   *  or null before any scoring. Server-computed — the UI never derives it. */
  rank: number | null;
}

/** A live-quiz session, redacted for the requesting viewer. */
export interface LiveQuizSessionDto {
  id: string;
  quizId: string;
  title: string;
  theme: QuizThemeDto;
  difficulty: QuizDifficultyDto;
  classId: string | null;
  status: LiveQuizStatusDto;
  questionCount: number;
  /** Index of the live question (-1 before the first advance). */
  currentIndex: number;
  /** The current question (player-redacted), or null in the lobby / after end. */
  question: LiveQuizQuestionPublicDto | null;
  /** The viewer's own participant state, or null if they haven't joined. */
  you: LiveQuizSelfDto | null;
  leaderboard: LiveQuizLeaderRowDto[];
  isHost: boolean;
  participantCount: number;
  startedAt: Date | null;
  endedAt: Date | null;
}

/** Result of submitting one answer (returned only to the answering player). */
export interface LiveQuizAnswerResultDto {
  correct: boolean;
  /** Points earned for this answer. */
  points: number;
  /** The player's new running total. */
  score: number;
  streak: number;
}

/** A joinable/active session in discovery lists. */
export interface LiveQuizSessionSummaryDto {
  id: string;
  quizId: string;
  title: string;
  theme: QuizThemeDto;
  difficulty: QuizDifficultyDto;
  classId: string | null;
  className: string | null;
  status: LiveQuizStatusDto;
  participantCount: number;
  joined: boolean;
  isHost: boolean;
  createdAt: Date;
}
