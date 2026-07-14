// =============================================================================
// Live Quiz — pure scoring engine (Kahoot-style, curriculum-themed)
// =============================================================================
// A teacher hosts a live multiple-choice quiz; students answer against a clock
// and score MORE for answering correctly AND quickly, with a streak bonus for
// consecutive correct answers. Question banks are themed (Geography / Science /
// Art / Literature / General) so one engine serves every subject variant.
//
// Pure + framework-independent: no I/O. The SMS service owns question storage,
// the server-authoritative clock, and reveal timing; this module only decides
// how many points an answer is worth. Server authority (spec §9): the correct
// index is NEVER sent to a client before reveal — that is the service's job; the
// engine just scores a (correct, elapsed) pair.
// =============================================================================

import { GAME_DIFFICULTIES, type GameDifficulty } from "./difficulty";

/** Curriculum themes a quiz can be built for. GENERAL = mixed / form-time. */
export const QUIZ_THEMES = ["GEOGRAPHY", "SCIENCE", "ART", "LITERATURE", "GENERAL"] as const;
export type QuizTheme = (typeof QUIZ_THEMES)[number];

export function isQuizTheme(s: string): s is QuizTheme {
  return (QUIZ_THEMES as readonly string[]).includes(s);
}

/**
 * One quiz question. `answerIndex` is authoritative and server-only. 2–6 choices
 * are allowed; exactly one is correct. `theme`/`difficulty` let a host assemble
 * a themed round of a chosen difficulty from a mixed bank.
 */
export interface QuizQuestion {
  id: string;
  prompt: string;
  choices: string[];
  answerIndex: number;
  theme: QuizTheme;
  difficulty: GameDifficulty;
}

/** Per-difficulty pacing + reward. Harder = less time, more points at stake. */
export interface QuizDifficultySpec {
  /** Seconds a player has to answer each question. */
  timeLimitSeconds: number;
  /** Points for a correct answer given instantly (decays with time — see score). */
  basePoints: number;
}

export const QUIZ_DIFFICULTY_SPECS: Record<GameDifficulty, QuizDifficultySpec> = {
  EASY: { timeLimitSeconds: 30, basePoints: 600 },
  MEDIUM: { timeLimitSeconds: 20, basePoints: 800 },
  HARD: { timeLimitSeconds: 12, basePoints: 1000 },
};

/** Extra points per already-held streak step, capped so it never dominates. */
export const QUIZ_STREAK_BONUS = 100;
export const QUIZ_MAX_STREAK_BONUS_STEPS = 5;

export interface QuizAnswerInput {
  correct: boolean;
  /** Milliseconds from question-shown to answer-submitted (server-measured). */
  elapsedMs: number;
  /** The player's streak of correct answers BEFORE this question (>= 0). */
  priorStreak: number;
  difficulty: GameDifficulty;
}

export interface QuizAnswerScore {
  /** Points awarded for this answer (0 if wrong or out of time). */
  points: number;
  /** The player's streak AFTER this answer. */
  newStreak: number;
}

/**
 * Score a single answer (spec-style pure function).
 *
 * Correct answers earn `basePoints` scaled by how much of the clock remained: an
 * instant answer keeps the full base, an answer at the buzzer keeps HALF — a
 * smooth linear decay from 1.0 → 0.5 across the time limit (Kahoot's model).
 * A wrong answer or a timeout (elapsed >= limit) earns 0 and RESETS the streak.
 * A correct answer adds a streak bonus that grows with the prior streak, capped.
 *
 * Total function: negative/overshoot elapsed is clamped; unknown difficulty
 * would be a type error at the boundary, so the map access is safe.
 */
export function scoreQuizAnswer(input: QuizAnswerInput): QuizAnswerScore {
  const spec = QUIZ_DIFFICULTY_SPECS[input.difficulty];
  const limitMs = spec.timeLimitSeconds * 1000;
  const elapsed = Math.max(0, Math.min(input.elapsedMs, limitMs));
  const priorStreak = Math.max(0, Math.floor(input.priorStreak));

  // Wrong, or the clock ran out → no points, streak broken.
  if (!input.correct || input.elapsedMs >= limitMs) {
    return { points: 0, newStreak: 0 };
  }

  // Linear speed factor 1.0 (instant) → 0.5 (at the buzzer).
  const speedFactor = 1 - (elapsed / limitMs) * 0.5;
  const base = Math.round(spec.basePoints * speedFactor);

  const bonusSteps = Math.min(priorStreak, QUIZ_MAX_STREAK_BONUS_STEPS);
  const bonus = bonusSteps * QUIZ_STREAK_BONUS;

  return { points: base + bonus, newStreak: priorStreak + 1 };
}

/** Validate a question is well-formed (2–6 choices, exactly one valid answer). */
export function isValidQuizQuestion(q: QuizQuestion): boolean {
  if (!q || typeof q.prompt !== "string" || q.prompt.trim() === "") return false;
  if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 6) return false;
  if (q.choices.some((c) => typeof c !== "string" || c.trim() === "")) return false;
  if (!Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex >= q.choices.length) return false;
  if (!isQuizTheme(q.theme)) return false;
  return (GAME_DIFFICULTIES as readonly string[]).includes(q.difficulty);
}

/** A player's running total across a quiz. */
export interface QuizStanding {
  playerId: string;
  score: number;
  correct: number;
  streak: number;
}

/**
 * Rank players for the leaderboard: highest score first, then most-correct, then
 * playerId for a stable, deterministic tiebreak. Pure; returns a new array.
 */
export function rankQuizStandings(standings: QuizStanding[]): QuizStanding[] {
  return [...standings].sort(
    (a, b) => b.score - a.score || b.correct - a.correct || a.playerId.localeCompare(b.playerId),
  );
}
