// =============================================================================
// Hangman — pure state machine
// =============================================================================
// Classic letter-guessing. The word is server-only (spec §9 authority); the
// client sees only the MASKED word and the guesses so far. Difficulty sets the
// number of wrong guesses allowed (lives) and — advisory for word selection —
// the word-length band. Curriculum word lists (per subject/theme) live in the
// SMS service; this engine only runs the rules.
//
// Pure + framework-independent: every function is total and returns a NEW state
// (immutable), so it is trivially testable and safe to drive from a service.
// =============================================================================

import type { GameDifficulty } from "./difficulty";

/** Per-difficulty lives + advisory word-length band for selection. */
export interface HangmanDifficultySpec {
  /** Wrong guesses allowed before the game is lost. */
  lives: number;
  /** Advisory min/max word length the SMS word-picker should target. */
  minWordLength: number;
  maxWordLength: number;
}

export const HANGMAN_DIFFICULTY_SPECS: Record<GameDifficulty, HangmanDifficultySpec> = {
  EASY: { lives: 8, minWordLength: 3, maxWordLength: 6 },
  MEDIUM: { lives: 6, minWordLength: 6, maxWordLength: 9 },
  HARD: { lives: 5, minWordLength: 9, maxWordLength: 16 },
};

export type HangmanStatus = "PLAYING" | "WON" | "LOST";

export interface HangmanState {
  /** The target word, UPPER-CASED. Server-only — never send to the client. */
  readonly word: string;
  /** Letters guessed so far (upper-case), in guess order, de-duplicated. */
  readonly guessed: readonly string[];
  /** Count of guessed letters NOT in the word. */
  readonly wrong: number;
  /** Wrong guesses allowed (from difficulty). */
  readonly lives: number;
  readonly status: HangmanStatus;
}

const LETTER = /^[A-Z]$/;

/** True when the word contains ONLY letters A–Z (spaces/hyphens rejected). */
export function isValidHangmanWord(word: string): boolean {
  return typeof word === "string" && word.length > 0 && /^[A-Za-z]+$/.test(word);
}

/** Start a new game for `word` at `difficulty`. Throws on a non-letter word. */
export function newHangmanState(word: string, difficulty: GameDifficulty): HangmanState {
  if (!isValidHangmanWord(word)) {
    throw new Error("newHangmanState: word must be one or more letters A-Z");
  }
  return {
    word: word.toUpperCase(),
    guessed: [],
    wrong: 0,
    lives: HANGMAN_DIFFICULTY_SPECS[difficulty].lives,
    status: "PLAYING",
  };
}

export interface HangmanGuessResult {
  state: HangmanState;
  /** True if this specific guess was already made (ignored, no life lost). */
  duplicate: boolean;
  /** True if the guessed letter is in the word. */
  hit: boolean;
}

/**
 * Apply a single-letter guess. Total function: a non-letter or multi-char guess
 * is rejected as a duplicate-style no-op (never mutates lives); a repeat guess
 * is ignored; a guess after the game ended is a no-op. Returns a NEW state.
 */
export function guessLetter(state: HangmanState, letter: string): HangmanGuessResult {
  const L = typeof letter === "string" ? letter.toUpperCase() : "";
  if (!LETTER.test(L) || state.status !== "PLAYING") {
    return { state, duplicate: true, hit: false };
  }
  if (state.guessed.includes(L)) {
    return { state, duplicate: true, hit: state.word.includes(L) };
  }

  const guessed = [...state.guessed, L];
  const hit = state.word.includes(L);
  const wrong = hit ? state.wrong : state.wrong + 1;

  // Won when every distinct letter of the word has been guessed.
  const won = [...new Set(state.word.split(""))].every((ch) => guessed.includes(ch));
  const lost = wrong >= state.lives;
  const status: HangmanStatus = won ? "WON" : lost ? "LOST" : "PLAYING";

  return { state: { ...state, guessed, wrong, status }, duplicate: false, hit };
}

/**
 * The masked word for display: revealed letters shown, unguessed shown as `mask`
 * (default "_"). On a LOST game the full word is revealed. Never leaks unguessed
 * letters while PLAYING.
 */
export function maskedWord(state: HangmanState, mask = "_"): string {
  if (state.status === "LOST") return state.word;
  return state.word
    .split("")
    .map((ch) => (state.guessed.includes(ch) ? ch : mask))
    .join("");
}

/** Wrong guesses remaining (never negative). */
export function livesRemaining(state: HangmanState): number {
  return Math.max(0, state.lives - state.wrong);
}
