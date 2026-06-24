// =============================================================================
// GameSettingsController — per-school game config (spec §8/§12)
// =============================================================================
// GET is broad (`game.leaderboard.read`) so any player/staff can read the
// school's effective config (e.g. difficulty options). PUT is `game.settings.manage`
// — school_admin only (configuration is their remit, §8). Inputs Zod-validated.
// =============================================================================

import { Body, Controller, Get, Put } from "@nestjs/common";
import { z } from "zod";
import { GAME_PERMISSIONS } from "@sms/types";
import type { GameSettingsDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { GameSettingsService } from "./game-settings.service";

const patchSchema = z
  .object({
    gamesEnabled: z.boolean(),
    defaultDifficulty: z.number().int(),
    guessRateLimitMs: z.number().int(),
    ringTurnLimitSec: z.number().int(),
    leagueMatchWindowHours: z.number().int(),
    crossSchoolEnabled: z.boolean(),
  })
  .partial();

@Controller("game-settings")
export class GameSettingsController {
  constructor(private readonly settings: GameSettingsService) {}

  @Get()
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  get(@CurrentPrincipal() p: Principal): Promise<GameSettingsDto> {
    return this.settings.get(p);
  }

  @Put()
  @RequirePermission(GAME_PERMISSIONS.SETTINGS_MANAGE)
  update(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(patchSchema)) body: z.infer<typeof patchSchema>,
  ): Promise<GameSettingsDto> {
    return this.settings.update(p, body);
  }
}
