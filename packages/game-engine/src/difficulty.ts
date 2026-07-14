// =============================================================================
// Shared difficulty scale for the classroom game suite
// =============================================================================
// A single, human-legible difficulty scale (EASY / MEDIUM / HARD) that every
// new game interprets in its OWN terms — quiz timers, typing passage length,
// hangman lives, board-game time controls. Keeping one scale means a school's
// GameSettings.defaultDifficulty and a teacher's per-match choice read the same
// everywhere, and the UI shows one consistent control.
//
// Pure + framework-independent, exactly like `scoring` — no I/O, so it is reused
// unchanged by the engines and (later) the SMS services and web.
// =============================================================================

/** The classroom difficulty scale, easiest → hardest. */
export const GAME_DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;

/** One difficulty level — set per game/match, never per player. */
export type GameDifficulty = (typeof GAME_DIFFICULTIES)[number];

/** Narrow an arbitrary string to a supported difficulty (total; never throws). */
export function isGameDifficulty(s: string): s is GameDifficulty {
  return (GAME_DIFFICULTIES as readonly string[]).includes(s);
}

/**
 * Time-control presets (whole seconds per player) for the turn-based board games
 * (chess, checkers). Difficulty here means "less time to think" — the board and
 * rules never change, so this is fair and purely about pace. `increment` is the
 * Fischer bonus added AFTER each move.
 */
export interface TimeControl {
  /** Total clock per player, in seconds. */
  baseSeconds: number;
  /** Seconds added to a player's clock after they complete a move. */
  incrementSeconds: number;
  /** Human label, e.g. "Rapid". */
  label: string;
}

export const BOARD_TIME_CONTROLS: Record<GameDifficulty, TimeControl> = {
  // Classical: long, relaxed — for learners.
  EASY: { baseSeconds: 15 * 60, incrementSeconds: 10, label: "Classical" },
  // Rapid: brisk but thoughtful.
  MEDIUM: { baseSeconds: 5 * 60, incrementSeconds: 5, label: "Rapid" },
  // Blitz: fast, for confident players.
  HARD: { baseSeconds: 3 * 60, incrementSeconds: 2, label: "Blitz" },
};
