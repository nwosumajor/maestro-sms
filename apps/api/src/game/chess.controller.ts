// =============================================================================
// ChessController — REST surface for the 2-player chess duel
// =============================================================================
// A peer duel like checkers: create/join/move/resign are `game.play`; reads are
// `game.leaderboard.read`. ChessService narrows to the caller's school (RLS) +
// participant relationship (404-not-403); every move is validated server-side by
// the full-rules engine.
// =============================================================================

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { GAME_PERMISSIONS, MODULES } from "@sms/types";
import type { ChessGameDto, ChessSummaryDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { ChessService } from "./chess.service";

const sq = z.tuple([z.number().int().min(0).max(7), z.number().int().min(0).max(7)]);
const moveSchema = z.object({
  from: sq,
  to: sq,
  promotion: z.enum(["q", "r", "b", "n"]).optional(),
  castle: z.enum(["K", "Q"]).optional(),
});

@RequireModule(MODULES.GAMES)
@Controller()
export class ChessController {
  constructor(private readonly chess: ChessService) {}

  @Post("chess")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  create(@CurrentPrincipal() p: Principal): Promise<ChessGameDto> {
    return this.chess.createGame(p);
  }

  @Get("chess")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  list(@CurrentPrincipal() p: Principal): Promise<ChessSummaryDto[]> {
    return this.chess.listGames(p);
  }

  @Get("chess/:id")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<ChessGameDto> {
    return this.chess.getGame(p, id);
  }

  @Post("chess/:id/join")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  join(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<ChessGameDto> {
    return this.chess.joinGame(p, id);
  }

  @Post("chess/:id/move")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  move(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(moveSchema)) body: z.infer<typeof moveSchema>,
  ): Promise<ChessGameDto> {
    return this.chess.move(p, id, body);
  }

  @Post("chess/:id/resign")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  resign(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<ChessGameDto> {
    return this.chess.resign(p, id);
  }
}
