// =============================================================================
// HangmanController — REST surface for the classroom hangman game
// =============================================================================
// Hosting a round (open/start/end) is `game.hangman.host` (teacher: own classes;
// principal/school_admin: school-wide). Joining/guessing is `game.play`. Reads
// are `game.leaderboard.read`. HangmanService narrows to the caller's school
// (RLS) + class relationship (404-not-403); the word never crosses the wire to a
// player until the round finishes.
// =============================================================================

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { GAME_PERMISSIONS, MODULES } from "@sms/types";
import type { HangmanGameDto, HangmanGuessResultDto, HangmanSummaryDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { HangmanService } from "./hangman.service";

const openSchema = z.object({
  classId: z.string().uuid(),
  difficulty: z.string().optional(),
  word: z.string().max(24).optional(),
});
const guessSchema = z.object({ letter: z.string().min(1).max(1) });

@RequireModule(MODULES.GAMES)
@Controller()
export class HangmanController {
  constructor(private readonly hangman: HangmanService) {}

  @Post("hangman")
  @RequirePermission(GAME_PERMISSIONS.HANGMAN_HOST)
  open(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(openSchema)) body: z.infer<typeof openSchema>,
  ): Promise<HangmanGameDto> {
    return this.hangman.openGame(p, body);
  }

  @Get("hangman")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  list(@CurrentPrincipal() p: Principal): Promise<HangmanSummaryDto[]> {
    return this.hangman.listGames(p);
  }

  @Get("hangman/:id")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<HangmanGameDto> {
    return this.hangman.getGame(p, id);
  }

  @Post("hangman/:id/join")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  join(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<HangmanGameDto> {
    return this.hangman.joinGame(p, id);
  }

  @Post("hangman/:id/start")
  @RequirePermission(GAME_PERMISSIONS.HANGMAN_HOST)
  start(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<HangmanGameDto> {
    return this.hangman.startGame(p, id);
  }

  @Post("hangman/:id/guess")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  guess(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(guessSchema)) body: z.infer<typeof guessSchema>,
  ): Promise<HangmanGuessResultDto> {
    return this.hangman.guess(p, id, body.letter);
  }

  @Post("hangman/:id/end")
  @RequirePermission(GAME_PERMISSIONS.HANGMAN_HOST)
  end(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<HangmanGameDto> {
    return this.hangman.endGame(p, id);
  }
}
