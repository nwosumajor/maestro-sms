// =============================================================================
// Effective game settings (spec §8/§12) — shared defaults + merge helper
// =============================================================================
// Every game service reads the school's GameSettings row through `effective(...)`
// so behaviour is driven by config when present and by platform defaults when
// absent (a school that never touched settings still plays with sane values).
// Kept dependency-free so services can use it via their existing `tx` without a
// new injected provider.

import type { GameSettingsDto } from "@sms/types";

/** Platform defaults — must match the Prisma column defaults on GameSettings. */
export const DEFAULT_GAME_SETTINGS: GameSettingsDto = {
  gamesEnabled: true,
  defaultDifficulty: 4,
  guessRateLimitMs: 750,
  ringTurnLimitSec: 60,
  leagueMatchWindowHours: 48,
  crossSchoolEnabled: false,
};

/** Merge a (possibly absent) school settings row over the platform defaults. */
export function effectiveGameSettings(
  row: Partial<GameSettingsDto> | null | undefined,
): GameSettingsDto {
  if (!row) return { ...DEFAULT_GAME_SETTINGS };
  return {
    gamesEnabled: row.gamesEnabled ?? DEFAULT_GAME_SETTINGS.gamesEnabled,
    defaultDifficulty: row.defaultDifficulty ?? DEFAULT_GAME_SETTINGS.defaultDifficulty,
    guessRateLimitMs: row.guessRateLimitMs ?? DEFAULT_GAME_SETTINGS.guessRateLimitMs,
    ringTurnLimitSec: row.ringTurnLimitSec ?? DEFAULT_GAME_SETTINGS.ringTurnLimitSec,
    leagueMatchWindowHours:
      row.leagueMatchWindowHours ?? DEFAULT_GAME_SETTINGS.leagueMatchWindowHours,
    crossSchoolEnabled: row.crossSchoolEnabled ?? DEFAULT_GAME_SETTINGS.crossSchoolEnabled,
  };
}
