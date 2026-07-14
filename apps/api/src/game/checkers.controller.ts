// =============================================================================
// CheckersController — REST surface for the 2-player checkers duel
// =============================================================================
// A peer duel like the Dead & Wounded duel: create/join/move/resign are
// `game.play` (any player); reads are `game.leaderboard.read`. CheckersService
// narrows to the caller's school (RLS) + participant relationship (404-not-403);
// every move is validated server-side by the engine.
// =============================================================================

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { GAME_PERMISSIONS, MODULES } from "@sms/types";
import type { CheckersGameDto, CheckersSummaryDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { CheckersService } from "./checkers.service";

const sq = z.tuple([z.number().int().min(0).max(7), z.number().int().min(0).max(7)]);
const createSchema = z.object({ difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).optional() });
const moveSchema = z.object({
  from: sq,
  path: z.array(sq).min(1).max(6),
  captured: z.array(sq).max(12),
});

@RequireModule(MODULES.GAMES)
@Controller()
export class CheckersController {
  constructor(private readonly checkers: CheckersService) {}

  @Post("checkers")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ): Promise<CheckersGameDto> {
    return this.checkers.createGame(p, body);
  }

  @Get("checkers")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  list(@CurrentPrincipal() p: Principal): Promise<CheckersSummaryDto[]> {
    return this.checkers.listGames(p);
  }

  @Get("checkers/:id")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CheckersGameDto> {
    return this.checkers.getGame(p, id);
  }

  @Post("checkers/:id/join")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  join(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CheckersGameDto> {
    return this.checkers.joinGame(p, id);
  }

  @Post("checkers/:id/move")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  move(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(moveSchema)) body: z.infer<typeof moveSchema>,
  ): Promise<CheckersGameDto> {
    return this.checkers.move(p, id, body);
  }

  @Post("checkers/:id/resign")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  resign(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CheckersGameDto> {
    return this.checkers.resign(p, id);
  }

  @Post("checkers/:id/claim-time")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  claimTime(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CheckersGameDto> {
    return this.checkers.claimTime(p, id);
  }
}
