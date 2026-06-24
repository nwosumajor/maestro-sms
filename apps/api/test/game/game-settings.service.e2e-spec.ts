// =============================================================================
// GameSettingsService integration — real DB, app role, RLS in force (spec §8)
// =============================================================================
// Proves the per-school game config end to end against Postgres:
//   - get returns platform defaults when no row exists
//   - update upserts; get reflects it; validation rejects out-of-range tunables
//   - tenant isolation: one school's config never affects another's
//   - the config is EFFECTIVE: gamesEnabled gates opening a game, and
//     defaultDifficulty is used when a game is opened without a difficulty
//
// Needs TEST_DATABASE_URL (app role; also DATABASE_URL for the Prisma singleton)
// + TEST_ADMIN_URL (superuser, to seed). Skips otherwise so it never false-passes.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { GameSettingsService } from "../../src/game/game-settings.service";
import { GameService } from "../../src/game/game.service";
import { CompetitionService } from "../../src/game/competition.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("GameSettingsService integration (per-school config, RLS, effective behaviour)", () => {
  let admin: Pool;
  let settings: GameSettingsService;
  let games: GameService;

  const SA = randomUUID();
  const SB = randomUUID();
  const adminA = randomUUID();
  const adminB = randomUUID();

  const admP = (userId: string, schoolId: string): Principal => ({
    userId,
    schoolId,
    roles: ["school_admin"],
    permissions: ["game.settings.manage", "game.play"],
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'GS_A',$2,now()),($3,'GS_B',$4,now())`,
      [SA, "gsa-" + SA, SB, "gsb-" + SB],
    );
    for (const [u, s] of [
      [adminA, SA],
      [adminB, SB],
    ] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,'Admin','x',now())`,
        [u, s, u + "@t"],
      );
    }
    const tenant = new PrismaTenantService() as never;
    const auditSvc = new AuditLogService() as never;
    settings = new GameSettingsService(tenant, auditSvc);
    games = new GameService(tenant, auditSvc, new CompetitionService(tenant, auditSvc));
  });

  afterAll(async () => {
    for (const t of ["game_player", "game", "game_settings", "audit_log"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, [[SA, SB]]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("returns platform defaults when no row exists", async () => {
    const s = await settings.get(admP(adminB, SB));
    expect(s).toMatchObject({
      gamesEnabled: true,
      defaultDifficulty: 4,
      guessRateLimitMs: 750,
      ringTurnLimitSec: 60,
      leagueMatchWindowHours: 48,
      crossSchoolEnabled: false,
    });
  });

  it("upserts on update and reflects it on get", async () => {
    await settings.update(admP(adminA, SA), { defaultDifficulty: 6, ringTurnLimitSec: 45 });
    const s = await settings.get(admP(adminA, SA));
    expect(s.defaultDifficulty).toBe(6);
    expect(s.ringTurnLimitSec).toBe(45);
    // A second update merges (doesn't reset untouched fields).
    await settings.update(admP(adminA, SA), { guessRateLimitMs: 1500 });
    const s2 = await settings.get(admP(adminA, SA));
    expect(s2.defaultDifficulty).toBe(6);
    expect(s2.guessRateLimitMs).toBe(1500);
  });

  it("rejects out-of-range tunables", async () => {
    await expect(settings.update(admP(adminA, SA), { defaultDifficulty: 7 })).rejects.toThrow();
    await expect(settings.update(admP(adminA, SA), { ringTurnLimitSec: 5 })).rejects.toThrow();
  });

  it("keeps each school's config isolated", async () => {
    await settings.update(admP(adminA, SA), { gamesEnabled: false });
    // School B never set anything → still the default (enabled).
    expect((await settings.get(admP(adminB, SB))).gamesEnabled).toBe(true);
  });

  it("is effective: gamesEnabled gates opening a game", async () => {
    await settings.update(admP(adminA, SA), { gamesEnabled: false });
    await expect(games.createGame(admP(adminA, SA), {})).rejects.toThrow(/disabled/i);
  });

  it("is effective: defaultDifficulty is used when none is given", async () => {
    await settings.update(admP(adminB, SB), { gamesEnabled: true, defaultDifficulty: 6 });
    const game = await games.createGame(admP(adminB, SB), {});
    expect(game.difficultyLength).toBe(6);
  });
});
