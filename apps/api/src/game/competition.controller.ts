// =============================================================================
// CompetitionController — REST surface for League/Knockout (spec §6/§8)
// =============================================================================
// Creating/operating a competition is `game.league.create` (principal /
// school_admin — the operations/configuration owners, spec §8); reads are
// `game.leaderboard.read` (own school). CompetitionService narrows everything to
// the caller's school (RLS) and verifies participants are in-school. Inputs are
// Zod-validated at the boundary; no secret ever crosses the wire (§9).
// =============================================================================

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { GAME_PERMISSIONS } from "@sms/types";
import type { CompetitionDetailDto, CompetitionDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { CompetitionService } from "./competition.service";

const createSchema = z.object({
  type: z.enum(["LEAGUE", "KNOCKOUT"]),
  name: z.string().min(1).max(120),
  difficultyLength: z.number().int().optional(),
  startAt: z.string(),
  endAt: z.string(),
  participantUserIds: z.array(z.string().uuid()).min(2),
});

@Controller("competitions")
export class CompetitionController {
  constructor(private readonly competitions: CompetitionService) {}

  @Post()
  @RequirePermission(GAME_PERMISSIONS.LEAGUE_CREATE)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ): Promise<CompetitionDetailDto> {
    return this.competitions.create(p, body);
  }

  @Get()
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  list(@CurrentPrincipal() p: Principal): Promise<CompetitionDto[]> {
    return this.competitions.list(p);
  }

  @Get(":id")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CompetitionDetailDto> {
    return this.competitions.get(p, id);
  }

  @Post(":id/start")
  @RequirePermission(GAME_PERMISSIONS.LEAGUE_CREATE)
  start(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CompetitionDetailDto> {
    return this.competitions.start(p, id);
  }

  @Post(":id/sweep")
  @RequirePermission(GAME_PERMISSIONS.LEAGUE_CREATE)
  sweep(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CompetitionDetailDto> {
    return this.competitions.sweep(p, id);
  }

  @Post(":id/cancel")
  @RequirePermission(GAME_PERMISSIONS.LEAGUE_CREATE)
  cancel(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CompetitionDetailDto> {
    return this.competitions.cancel(p, id);
  }
}
