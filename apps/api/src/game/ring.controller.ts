// =============================================================================
// RingController — REST surface for the Elimination Ring (spec §4/§8)
// =============================================================================
// Play (open/join/secret/guess/timeout/forfeit/read) is `game.play`; RingService
// narrows to the caller's school (RLS) and to rings they participate in
// (relationship scope, 404-not-403). Force-ending a ring is `game.match.moderate`
// (teacher/principal/school_admin). No secret ever crosses the wire (§9).
// =============================================================================

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { z } from "zod";
import { GAME_PERMISSIONS } from "@sms/types";
import type { RingDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { RingService } from "./ring.service";

const openSchema = z.object({ difficultyLength: z.number().int().optional() });
const secretSchema = z.object({ secret: z.string() });
const guessSchema = z.object({ value: z.string() });

@RequireModule(MODULES.GAMES)
@Controller("rings")
export class RingController {
  constructor(private readonly rings: RingService) {}

  @Post()
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  open(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(openSchema)) body: z.infer<typeof openSchema>,
  ): Promise<RingDto> {
    return this.rings.openRing(p, body);
  }

  @Get(":id")
  // Viewing is oversight-grade (players AND the staff who moderate/configure);
  // the service still scopes non-staff to their own seat, 404-not-403.
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<RingDto> {
    return this.rings.getRing(p, id);
  }

  @Post(":id/join")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  join(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<RingDto> {
    return this.rings.joinRing(p, id);
  }

  @Post(":id/start")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  start(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<RingDto> {
    return this.rings.startRing(p, id);
  }

  @Post(":id/secret")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  secret(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(secretSchema)) body: z.infer<typeof secretSchema>,
  ): Promise<RingDto> {
    return this.rings.submitSecret(p, id, body.secret);
  }

  @Post(":id/guess")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  guess(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(guessSchema)) body: z.infer<typeof guessSchema>,
  ): Promise<{ dead: number; wounded: number }> {
    return this.rings.guess(p, id, body.value);
  }

  @Post(":id/timeout")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  timeout(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<RingDto> {
    return this.rings.timeoutTurn(p, id);
  }

  @Post(":id/forfeit")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  forfeit(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<RingDto> {
    return this.rings.forfeit(p, id);
  }

  @Post(":id/end")
  @RequirePermission(GAME_PERMISSIONS.MATCH_MODERATE)
  end(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<RingDto> {
    return this.rings.endRing(p, id);
  }
}
