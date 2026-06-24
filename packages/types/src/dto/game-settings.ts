// Per-school Dead & Wounded settings DTO (platform spec §8/§12, step 7).
// The school's game configuration that `game.settings.manage` controls and the
// game services read. Returned by GET /game-settings as the EFFECTIVE values
// (school row merged over platform defaults).

export interface GameSettingsDto {
  /** Master switch — when false, no new games/competitions may be opened. */
  gamesEnabled: boolean;
  /** Difficulty (4|5|6) used when a game is opened without specifying one. */
  defaultDifficulty: number;
  /** Minimum ms between a racer's guesses (Class Race anti-abuse, §5/§12). */
  guessRateLimitMs: number;
  /** Elimination Ring per-turn limit in seconds (§4/§12). */
  ringTurnLimitSec: number;
  /** League/Knockout per-match play window in hours (§6/§12). */
  leagueMatchWindowHours: number;
  /** School opt-in posture for the cross-school Ultimate (consumed in step 8). */
  crossSchoolEnabled: boolean;
}

/** Partial update accepted by PUT /game-settings (all fields optional). */
export type GameSettingsPatchDto = Partial<GameSettingsDto>;
