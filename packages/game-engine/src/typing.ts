// =============================================================================
// Typing Race — pure scoring engine
// =============================================================================
// Students race to type a shared passage accurately. Speed is measured in the
// standard WPM (a "word" = 5 characters) and adjusted for accuracy, so hammering
// keys fast but wrongly does not win. Difficulty selects the passage profile
// (length / punctuation / numbers) and a target WPM for grading.
//
// Pure + framework-independent: the SMS service owns passages, the server clock,
// and per-racer redaction; this module scores a (target, typed, elapsed) triple.
// =============================================================================

import type { GameDifficulty } from "./difficulty";

/** Characters per standardised "word" (industry-standard WPM definition). */
export const CHARS_PER_WORD = 5;

/** Per-difficulty passage profile + the WPM considered a strong result. */
export interface TypingDifficultySpec {
  minChars: number;
  maxChars: number;
  includePunctuation: boolean;
  includeNumbers: boolean;
  /** WPM at/above which the result is graded "excellent" (for stars/badges). */
  targetWpm: number;
}

export const TYPING_DIFFICULTY_SPECS: Record<GameDifficulty, TypingDifficultySpec> = {
  EASY: { minChars: 80, maxChars: 140, includePunctuation: false, includeNumbers: false, targetWpm: 25 },
  MEDIUM: { minChars: 140, maxChars: 240, includePunctuation: true, includeNumbers: false, targetWpm: 40 },
  HARD: { minChars: 240, maxChars: 360, includePunctuation: true, includeNumbers: true, targetWpm: 60 },
};

export interface TypingResult {
  /** Correctly-typed characters (longest correct prefix + matched positions). */
  correctChars: number;
  /** Positions where the typed char differs from the target. */
  errors: number;
  /** Accuracy 0..1 over what was typed (1 when nothing typed). */
  accuracy: number;
  /** Gross words-per-minute = (typedChars / 5) / minutes. */
  grossWpm: number;
  /** Accuracy-adjusted WPM = gross * accuracy (never negative). */
  netWpm: number;
  /** True once the entire target has been typed correctly. */
  finished: boolean;
}

/**
 * Score a typing attempt against the target passage.
 *
 * Correctness is per-position over the overlap of `typed` and `target`
 * (position i is correct iff typed[i] === target[i]); anything typed beyond the
 * target length counts as an error. Accuracy = correct / typedLength. Gross WPM
 * uses the elapsed wall-clock; net WPM discounts gross by accuracy so error-spam
 * cannot beat clean typing. `finished` requires the full target typed correctly.
 *
 * Total function: zero/negative elapsed yields 0 WPM rather than dividing by
 * zero; empty `typed` yields a neutral (accuracy 1, 0 WPM) result.
 */
export function computeTypingResult(target: string, typed: string, elapsedMs: number): TypingResult {
  const typedLen = typed.length;
  const overlap = Math.min(typedLen, target.length);

  let correctChars = 0;
  for (let i = 0; i < overlap; i++) {
    if (typed[i] === target[i]) correctChars++;
  }
  // Anything typed past the end of the target is wrong; mismatches within the
  // overlap are wrong too.
  const errors = typedLen - correctChars;
  const accuracy = typedLen === 0 ? 1 : correctChars / typedLen;

  const minutes = elapsedMs > 0 ? elapsedMs / 60000 : 0;
  const grossWpm = minutes > 0 ? typedLen / CHARS_PER_WORD / minutes : 0;
  const netWpm = Math.max(0, grossWpm * accuracy);

  const finished = typed.length === target.length && correctChars === target.length;

  return {
    correctChars,
    errors,
    accuracy,
    grossWpm: round2(grossWpm),
    netWpm: round2(netWpm),
    finished,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A finished racer's record for ranking. */
export interface TypingStanding {
  playerId: string;
  netWpm: number;
  accuracy: number;
  finished: boolean;
  /** Ms from the racer's own start to finishing (or giving up). */
  elapsedMs: number;
}

/**
 * Rank racers: finishers before non-finishers, then higher net WPM, then higher
 * accuracy, then faster elapsed, then playerId (stable). Pure; new array.
 */
export function rankTypingStandings(standings: TypingStanding[]): TypingStanding[] {
  return [...standings].sort(
    (a, b) =>
      Number(b.finished) - Number(a.finished) ||
      b.netWpm - a.netWpm ||
      b.accuracy - a.accuracy ||
      a.elapsedMs - b.elapsedMs ||
      a.playerId.localeCompare(b.playerId),
  );
}
