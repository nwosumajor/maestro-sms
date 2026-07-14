// =============================================================================
// TypingRaceController — REST surface for the classroom typing game
// =============================================================================
// Hosting a race (open/start/end) is `game.typing.host` (teacher: own classes;
// principal/school_admin: school-wide). Joining/reporting progress is
// `game.play`. Reads are `game.leaderboard.read`. TypingRaceService narrows to
// the caller's school (RLS) + class relationship (404-not-403). WPM is computed
// server-side from the reported text — never trusted from the client.
// =============================================================================

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { GAME_PERMISSIONS, MODULES } from "@sms/types";
import type { TypingProgressResultDto, TypingRaceDto, TypingRaceSummaryDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { TypingRaceService } from "./typing-race.service";

const openSchema = z.object({
  classId: z.string().uuid(),
  difficulty: z.string().optional(),
  passage: z.string().max(600).optional(),
});
const progressSchema = z.object({ typed: z.string().max(700) });

@RequireModule(MODULES.GAMES)
@Controller()
export class TypingRaceController {
  constructor(private readonly typing: TypingRaceService) {}

  @Post("typing-races")
  @RequirePermission(GAME_PERMISSIONS.TYPING_HOST)
  open(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(openSchema)) body: z.infer<typeof openSchema>,
  ): Promise<TypingRaceDto> {
    return this.typing.openRace(p, body);
  }

  @Get("typing-races")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  list(@CurrentPrincipal() p: Principal): Promise<TypingRaceSummaryDto[]> {
    return this.typing.listRaces(p);
  }

  @Get("typing-races/:id")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<TypingRaceDto> {
    return this.typing.getRace(p, id);
  }

  @Post("typing-races/:id/join")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  join(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<TypingRaceDto> {
    return this.typing.joinRace(p, id);
  }

  @Post("typing-races/:id/start")
  @RequirePermission(GAME_PERMISSIONS.TYPING_HOST)
  start(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<TypingRaceDto> {
    return this.typing.startRace(p, id);
  }

  @Post("typing-races/:id/progress")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  progress(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(progressSchema)) body: z.infer<typeof progressSchema>,
  ): Promise<TypingProgressResultDto> {
    return this.typing.progress(p, id, body.typed);
  }

  @Post("typing-races/:id/end")
  @RequirePermission(GAME_PERMISSIONS.TYPING_HOST)
  end(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<TypingRaceDto> {
    return this.typing.endRace(p, id);
  }
}
