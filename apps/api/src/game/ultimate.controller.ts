// =============================================================================
// UltimateController — cross-school Ultimate REST surface (spec §7/§8)
// =============================================================================
// Strict per-tier gating:
//   - create / cancel competition .... game.ultimate.admin   (super_admin only)
//   - enroll a school ................ game.ultimate.enroll   (principal/school_admin)
//   - set per-student consent ........ game.ultimate.consent  (school_admin)
//   - enter / guess / my-entry ....... game.play              (student)
//   - list / leaderboard ............. game.leaderboard.read
// UltimateService verifies BOTH consent tiers (+ crossSchoolEnabled) before any
// entry. No secret and no PII ever cross the wire (spec §7/§9).
// =============================================================================

import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { GAME_PERMISSIONS } from "@sms/types";
import type {
  UltimateCompetitionDto,
  UltimateEntryDto,
  UltimateLeaderboardDto,
} from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { UltimateService } from "./ultimate.service";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  difficultyLength: z.number().int(),
  startAt: z.string(),
  endAt: z.string(),
});
const consentSchema = z.object({ studentId: z.string().uuid(), granted: z.boolean() });
const enterSchema = z.object({ handle: z.string() });
const guessSchema = z.object({ value: z.string() });

@Controller("ultimate")
export class UltimateController {
  constructor(private readonly ultimate: UltimateService) {}

  // --- admin (super_admin) ------------------------------------------------
  @Post("competitions")
  @RequirePermission(GAME_PERMISSIONS.ULTIMATE_ADMIN)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ): Promise<UltimateCompetitionDto> {
    return this.ultimate.createCompetition(p, body);
  }

  @Post("competitions/:id/cancel")
  @RequirePermission(GAME_PERMISSIONS.ULTIMATE_ADMIN)
  cancel(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<UltimateCompetitionDto> {
    return this.ultimate.cancelCompetition(p, id);
  }

  // --- reads --------------------------------------------------------------
  @Get("competitions")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  list(@CurrentPrincipal() p: Principal): Promise<UltimateCompetitionDto[]> {
    return this.ultimate.list(p);
  }

  @Get("competitions/:id/leaderboard")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  leaderboard(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
  ): Promise<UltimateLeaderboardDto> {
    return this.ultimate.leaderboard(p, id);
  }

  // --- tier 1: school enrollment (principal/school_admin) ------------------
  @Post("competitions/:id/enroll")
  @RequirePermission(GAME_PERMISSIONS.ULTIMATE_ENROLL)
  enroll(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<UltimateCompetitionDto> {
    return this.ultimate.enrollSchool(p, id);
  }

  // --- tier 2: per-student consent (school_admin) -------------------------
  @Put("consent")
  @RequirePermission(GAME_PERMISSIONS.ULTIMATE_CONSENT)
  consent(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(consentSchema)) body: z.infer<typeof consentSchema>,
  ): Promise<{ studentId: string; granted: boolean }> {
    return this.ultimate.setConsent(p, body);
  }

  // --- entry + play (student) ---------------------------------------------
  @Post("competitions/:id/enter")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  enter(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(enterSchema)) body: z.infer<typeof enterSchema>,
  ): Promise<UltimateEntryDto> {
    return this.ultimate.enter(p, id, body.handle);
  }

  @Post("competitions/:id/guess")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  guess(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(guessSchema)) body: z.infer<typeof guessSchema>,
  ): Promise<{ dead: number; wounded: number }> {
    return this.ultimate.guess(p, id, body.value);
  }

  @Get("competitions/:id/me")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  me(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<UltimateEntryDto> {
    return this.ultimate.myEntry(p, id);
  }
}
