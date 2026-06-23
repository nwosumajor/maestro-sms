// =============================================================================
// Dead & Wounded — pure scoring engine (platform spec §2)
// =============================================================================
// The foundation EVERY game mode depends on. This module is deliberately
// framework-independent: no I/O, no database, no network, no SMS imports — just
// functions, so it can be proven correct in isolation and reused unchanged by
// every mode (duel, ring, race, league, ultimate).
//
// `length` (N, the difficulty) is ALWAYS a parameter — never hard-coded to 4.
// Supported difficulties are 4, 5, or 6 distinct digits (§2 "Difficulty levels").
// The maths is identical for any N; only the length changes.
// =============================================================================

/** Supported difficulty lengths (spec §2: 4, 5, or 6 distinct digits). */
export const DIFFICULTY_LENGTHS = [4, 5, 6] as const;

/** A difficulty length N — set per game/competition, never per player. */
export type DifficultyLength = (typeof DIFFICULTY_LENGTHS)[number];

/**
 * Result of scoring one guess against one secret (spec §2).
 *
 * NOTE: kept self-contained in the engine for build step 1. When the game is
 * folded into the SMS (spec §10 persistence model), this shape becomes the
 * shared DTO in `packages/types/src/dto/` — the engine stays the source of the
 * logic, `@sms/types` the source of the wire shape.
 */
export interface DeadWoundedResult {
  /** Count of positions where `guess[i] === secret[i]`. */
  dead: number;
  /**
   * Count of digits in `guess` that occur in `secret` at a DIFFERENT position,
   * EXCLUDING any digit already counted as dead. A dead digit is never wounded.
   */
  wounded: number;
}

/** Narrow an arbitrary number to a supported difficulty length. */
export function isDifficultyLength(n: number): n is DifficultyLength {
  // reason: `includes` on a readonly tuple of literals needs a widened element
  // type to accept an arbitrary number argument.
  return (DIFFICULTY_LENGTHS as readonly number[]).includes(n);
}

/**
 * Validate that `input` is a legal secret/guess for difficulty `length`:
 * exactly `length` characters, each an ASCII digit 0–9, and ALL DISTINCT.
 *
 * Total function — never throws; returns a boolean. `length` must itself be a
 * supported difficulty (4/5/6); any other length yields `false`. Rejects wrong
 * length, non-digit characters, and repeated digits (spec §2 rules).
 */
export function validate(input: string, length: number): boolean {
  if (!isDifficultyLength(length)) return false;
  if (typeof input !== "string" || input.length !== length) return false;

  const seen = new Set<string>();
  for (const ch of input) {
    if (ch < "0" || ch > "9") return false; // non-digit
    if (seen.has(ch)) return false; // repeated digit
    seen.add(ch);
  }
  return true;
}

/**
 * Score `guess` against `secret` and return `{ dead, wounded }` (spec §2).
 *
 * The difficulty length N is derived from the inputs (both must be the same
 * length). Both are validated defensively — server authority (§9) means a
 * malformed guess/secret must never silently produce a bogus score, so this
 * throws rather than returning a wrong number.
 *
 *   dead    — positions i where guess[i] === secret[i]
 *   wounded — digits present in secret at a different position, minus dead
 *
 * Because digits are distinct within each string, a present-but-misplaced digit
 * contributes exactly one wounded, and `dead + wounded <= N` always holds.
 */
export function score(guess: string, secret: string): DeadWoundedResult {
  const length = secret.length;
  if (!validate(secret, length) || !validate(guess, length)) {
    throw new Error(
      `score: guess and secret must each be ${length} distinct digits 0-9 of equal, supported length (4/5/6)`,
    );
  }

  let dead = 0;
  let wounded = 0;
  for (let i = 0; i < length; i++) {
    const g = guess[i] as string;
    if (g === secret[i]) {
      dead++;
    } else if (secret.includes(g)) {
      // Present in the secret but (since not equal here, and digits are
      // distinct) at a different position → wounded, never double-counted.
      wounded++;
    }
  }
  return { dead, wounded };
}

/**
 * A win is a guess scoring `dead === length` (which forces `wounded === 0`,
 * since `dead + wounded <= length`). Both are asserted for safety.
 */
export function isWin(result: DeadWoundedResult, length: number): boolean {
  return result.dead === length && result.wounded === 0;
}

/**
 * Generate a uniformly-random valid secret of `length` distinct digits (0–9)
 * via a Fisher–Yates shuffle of the digit alphabet.
 *
 * The RNG is injectable so callers can seed it deterministically in tests; it
 * defaults to `Math.random`. // SECURITY: a real game must inject a CSPRNG
 * (e.g. node:crypto) so opponents cannot predict secrets — the engine stays
 * runtime-agnostic and leaves that choice to the (server-side) orchestrator.
 */
export function generateSecret(length: number, rng: () => number = Math.random): string {
  if (!isDifficultyLength(length)) {
    throw new Error(`generateSecret: length must be one of ${DIFFICULTY_LENGTHS.join(", ")}`);
  }

  const digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
  for (let i = digits.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = digits[i] as string;
    digits[i] = digits[j] as string;
    digits[j] = tmp;
  }
  return digits.slice(0, length).join("");
}
