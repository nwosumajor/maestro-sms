// =============================================================================
// GameController — REST surface for the 2-player duel (platform spec §8/§10)
// =============================================================================
// Coarse `game.play` permission gates every endpoint (PermissionGuard + JWT);
// GameService narrows to the caller's school (RLS) and to games they participate
// in (relationship scope, 404-not-403). Inputs validated with Zod at the
// boundary; secrets are accepted but never returned (server authority, §9).
// =============================================================================

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { GAME_PERMISSIONS } from "@sms/types";
import type { DeadWoundedDto, GameDto, OpenGameDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { GameService } from "./game.service";

const createSchema = z.object({ difficultyLength: z.number().int().optional() });
const secretSchema = z.object({ secret: z.string() });
const guessSchema = z.object({ value: z.string() });

@Controller("games")
export class GameController {
  constructor(private readonly games: GameService) {}

  @Post()
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ): Promise<GameDto> {
    return this.games.createGame(p, body);
  }

  @Get("open")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  listOpen(@CurrentPrincipal() p: Principal): Promise<OpenGameDto[]> {
    return this.games.listOpenGames(p);
  }

  @Get(":id")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<GameDto> {
    return this.games.getGame(p, id);
  }

  @Post(":id/join")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  join(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<GameDto> {
    return this.games.joinGame(p, id);
  }

  @Post(":id/secret")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  secret(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(secretSchema)) body: z.infer<typeof secretSchema>,
  ): Promise<GameDto> {
    return this.games.submitSecret(p, id, body.secret);
  }

  @Post(":id/guess")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  guess(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(guessSchema)) body: z.infer<typeof guessSchema>,
  ): Promise<DeadWoundedDto> {
    return this.games.guess(p, id, body.value);
  }

  @Post(":id/forfeit")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  forfeit(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<GameDto> {
    return this.games.forfeit(p, id);
  }
}
