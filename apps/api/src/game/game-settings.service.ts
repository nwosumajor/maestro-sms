// =============================================================================
// GameSettingsService — per-school game configuration (spec §8/§12, step 7)
// =============================================================================
// Reads/writes the ONE GameSettings row per school. school_admin owns it via
// `game.settings.manage` (configuration is the school_admin's remit, §8); reads
// are broad (`game.leaderboard.read`). Tenant-scoped: schoolId from the JWT, RLS
// backstops; a school only ever sees/edits its own row. Updates are upserts (no
// row to read = defaults) and audited. The game services consult the same
// `effectiveGameSettings` so a change here actually changes play.
// =============================================================================

import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { isDifficultyLength } from "@sms/game-engine";
import type { GameSettingsDto, GameSettingsPatchDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { effectiveGameSettings } from "./game-settings.util";

@Injectable()
export class GameSettingsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** The school's effective settings (row merged over platform defaults). */
  async get(p: Principal): Promise<GameSettingsDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) =>
      effectiveGameSettings(await tx.gameSettings.findFirst({ where: { schoolId: p.schoolId } })),
    );
  }

  /** Upsert the school's settings from a validated partial patch. */
  async update(p: Principal, patch: GameSettingsPatchDto): Promise<GameSettingsDto> {
    const data = this.validate(patch);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.gameSettings.findFirst({ where: { schoolId: p.schoolId } });
      if (existing) {
        await tx.gameSettings.update({ where: { id: existing.id }, data });
      } else {
        await tx.gameSettings.create({ data: { schoolId: p.schoolId, ...data } });
      }
      await this.audit.record(
        {
          actorId: p.userId,
          action: "game.settings.update",
          entity: "game_settings",
          entityId: p.schoolId,
          schoolId: p.schoolId,
          metadata: data,
        },
        tx,
      );
      return effectiveGameSettings(await tx.gameSettings.findFirst({ where: { schoolId: p.schoolId } }));
    });
  }

  /** Validate + narrow a patch; rejects out-of-range tunables at the boundary. */
  private validate(patch: GameSettingsPatchDto) {
    const data: Record<string, unknown> = {};
    if (patch.gamesEnabled !== undefined) data.gamesEnabled = patch.gamesEnabled;
    if (patch.crossSchoolEnabled !== undefined) data.crossSchoolEnabled = patch.crossSchoolEnabled;
    if (patch.defaultDifficulty !== undefined) {
      if (!isDifficultyLength(patch.defaultDifficulty)) {
        throw new BadRequestException("defaultDifficulty must be 4, 5, or 6");
      }
      data.defaultDifficulty = patch.defaultDifficulty;
    }
    if (patch.guessRateLimitMs !== undefined) {
      this.range(patch.guessRateLimitMs, 0, 60_000, "guessRateLimitMs");
      data.guessRateLimitMs = patch.guessRateLimitMs;
    }
    if (patch.ringTurnLimitSec !== undefined) {
      this.range(patch.ringTurnLimitSec, 10, 600, "ringTurnLimitSec");
      data.ringTurnLimitSec = patch.ringTurnLimitSec;
    }
    if (patch.leagueMatchWindowHours !== undefined) {
      this.range(patch.leagueMatchWindowHours, 1, 720, "leagueMatchWindowHours");
      data.leagueMatchWindowHours = patch.leagueMatchWindowHours;
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException("no settings provided");
    }
    return data;
  }

  private range(n: number, min: number, max: number, name: string) {
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new BadRequestException(`${name} must be an integer in [${min}, ${max}]`);
    }
  }
}
