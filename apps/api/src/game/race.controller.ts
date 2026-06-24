// =============================================================================
// RaceController — REST surface for Class Race + tournament (spec §5/§8)
// =============================================================================
// Opening/starting/ending a race is `game.race.open` (teacher: own class;
// principal/school_admin: school-wide). Joining/guessing is `game.play`.
// Scheduling a cross-class tournament is `game.race.tournament` (principal/
// school_admin). Reads are `game.leaderboard.read`. RaceService narrows to the
// caller's school (RLS) + class relationship; no target ever crosses the wire.
// =============================================================================

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { GAME_PERMISSIONS } from "@sms/types";
import type { RaceDto, RaceSummaryDto, RaceTournamentDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { RaceService } from "./race.service";

const openSchema = z.object({
  classId: z.string().uuid(),
  difficultyLength: z.number().int().optional(),
  targetSecret: z.string().optional(),
});
const guessSchema = z.object({ value: z.string() });
const tournamentSchema = z.object({
  name: z.string().min(1).max(120),
  classIds: z.array(z.string().uuid()).min(1),
  difficultyLength: z.number().int().optional(),
  startAt: z.string(),
  endAt: z.string(),
});

@Controller()
export class RaceController {
  constructor(private readonly races: RaceService) {}

  @Post("races")
  @RequirePermission(GAME_PERMISSIONS.RACE_OPEN)
  open(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(openSchema)) body: z.infer<typeof openSchema>,
  ): Promise<RaceDto> {
    return this.races.openRace(p, body);
  }

  @Get("races")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  list(@CurrentPrincipal() p: Principal): Promise<RaceSummaryDto[]> {
    return this.races.listRaces(p);
  }

  @Get("races/:id")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<RaceDto> {
    return this.races.getRace(p, id);
  }

  @Post("races/:id/join")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  join(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<RaceDto> {
    return this.races.joinRace(p, id);
  }

  @Post("races/:id/start")
  @RequirePermission(GAME_PERMISSIONS.RACE_OPEN)
  start(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<RaceDto> {
    return this.races.startRace(p, id);
  }

  @Post("races/:id/guess")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  guess(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(guessSchema)) body: z.infer<typeof guessSchema>,
  ): Promise<{ dead: number; wounded: number }> {
    return this.races.guess(p, id, body.value);
  }

  @Post("races/:id/end")
  @RequirePermission(GAME_PERMISSIONS.RACE_OPEN)
  end(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<RaceDto> {
    return this.races.endRace(p, id);
  }

  @Post("race-tournaments")
  @RequirePermission(GAME_PERMISSIONS.RACE_TOURNAMENT)
  openTournament(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(tournamentSchema)) body: z.infer<typeof tournamentSchema>,
  ): Promise<RaceTournamentDto> {
    return this.races.openTournament(p, body);
  }

  @Get("race-tournaments/:id")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  getTournament(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
  ): Promise<RaceTournamentDto> {
    return this.races.getTournament(p, id);
  }
}
