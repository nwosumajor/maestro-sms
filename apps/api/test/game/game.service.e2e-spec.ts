// =============================================================================
// GameService integration — real DB, app role, RLS in force (spec §10 step 3)
// =============================================================================
// Proves the SMS-integration security model end to end against Postgres:
//   - a full duel persists and resolves to the right winner
//   - NO secret is ever returned in a game view (server authority, §9)
//   - secrets are cleared and results written when the game finishes (retention)
//   - turn order is server-enforced
//   - cross-tenant AND same-school non-participant access both 404 (never 403)
//
// Needs TEST_DATABASE_URL (app role; also exported as DATABASE_URL so the Prisma
// singleton connects as that role) + TEST_ADMIN_URL (superuser, to seed). Skips
// otherwise so it never false-passes.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { GameService } from "../../src/game/game.service";
import { CompetitionService } from "../../src/game/competition.service";
import { GameEventsService } from "../../src/game/game-events.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("GameService integration (RLS + persistence + server authority)", () => {
  let admin: Pool;
  let svc: GameService;

  const SA = randomUUID();
  const SB = randomUUID();
  const u1 = randomUUID(); // SA
  const u2 = randomUUID(); // SA
  const u4 = randomUUID(); // SA, non-participant
  const u3 = randomUUID(); // SB, other tenant

  const P = (userId: string, schoolId: string): Principal => ({
    userId,
    schoolId,
    roles: ["student"],
    permissions: ["game.play"],
  });

  const assertNoSecret = (v: unknown) => {
    const json = JSON.stringify(v);
    expect(json).not.toContain("1234");
    expect(json).not.toContain("5678");
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'GA',$2,now()),($3,'GB',$4,now())`,
      [SA, "ga-" + SA, SB, "gb-" + SB],
    );
    for (const [u, s, name] of [
      [u1, SA, "Alice"],
      [u2, SA, "Bob"],
      [u4, SA, "Carol"],
      [u3, SB, "Dave"],
    ] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, s, u + "@t", name],
      );
    }
    const tenant = new PrismaTenantService() as never;
    const auditSvc = new AuditLogService() as never;
    svc = new GameService(tenant, auditSvc, new CompetitionService(tenant, auditSvc, new GameEventsService()), new GameEventsService());
  });

  afterAll(async () => {
    for (const t of ["guess", "game_result", "game_player", "game", "audit_log"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, [[SA, SB]]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("plays a full duel, persists results, clears secrets, never leaks a secret", async () => {
    const p1 = P(u1, SA);
    const p2 = P(u2, SA);

    const created = await svc.createGame(p1, { difficultyLength: 4 });
    expect(created.status).toBe("LOBBY");
    assertNoSecret(created);
    const gid = created.id;

    expect((await svc.joinGame(p2, gid)).status).toBe("SETUP");
    await svc.submitSecret(p1, gid, "1234");
    const active = await svc.submitSecret(p2, gid, "5678");
    expect(active.status).toBe("ACTIVE");
    assertNoSecret(active);

    const view = await svc.getGame(p1, gid);
    const p1PlayerId = view.players.find((pl) => pl.userId === u1)!.playerId;
    const curIsP1 = view.currentTurnPlayerId === p1PlayerId;
    const cur = curIsP1 ? p1 : p2;
    const opp = curIsP1 ? p2 : p1;
    const curSecret = curIsP1 ? "1234" : "5678";
    const oppUserId = curIsP1 ? u2 : u1;

    // current player: a deliberately non-winning guess (turn passes)
    const r1 = await svc.guess(cur, gid, "9013");
    expect(r1.dead + r1.wounded).toBeLessThanOrEqual(4);
    // opponent cracks the current player's secret → wins
    const r2 = await svc.guess(opp, gid, curSecret);
    expect(r2).toEqual({ dead: 4, wounded: 0 });

    const final = await svc.getGame(p1, gid);
    expect(final.status).toBe("FINISHED");
    expect(final.winnerPlayerId).toBe(final.players.find((pl) => pl.userId === oppUserId)!.playerId);
    // The winner's CRACKING guess necessarily equals the cracked secret and shows
    // in the PUBLIC move log — that's a legitimately-made guess, not a server leak.
    // The invariants: the OTHER (un-cracked) secret never appears, and both stored
    // secrets are cleared (asserted against the DB just below).
    const uncrackedSecret = curIsP1 ? "5678" : "1234";
    expect(JSON.stringify(final)).not.toContain(uncrackedSecret);

    // DB: secrets cleared, two result rows (one WON)
    const secrets = await admin.query<{ secret: string | null }>(
      `SELECT secret FROM game_player WHERE "gameId"=$1`,
      [gid],
    );
    expect(secrets.rows.every((r) => r.secret === null)).toBe(true);
    const results = await admin.query<{ outcome: string }>(
      `SELECT outcome FROM game_result WHERE "gameId"=$1`,
      [gid],
    );
    expect(results.rowCount).toBe(2);
    expect(results.rows.map((r) => r.outcome)).toContain("WON");
  });

  it("enforces turn order (the non-current player cannot guess)", async () => {
    const p1 = P(u1, SA);
    const p2 = P(u2, SA);
    const g = await svc.createGame(p1, { difficultyLength: 4 });
    await svc.joinGame(p2, g.id);
    await svc.submitSecret(p1, g.id, "1234");
    await svc.submitSecret(p2, g.id, "5678");

    const view = await svc.getGame(p1, g.id);
    const p1PlayerId = view.players.find((pl) => pl.userId === u1)!.playerId;
    const notCurrent = view.currentTurnPlayerId === p1PlayerId ? p2 : p1;
    await expect(svc.guess(notCurrent, g.id, "9013")).rejects.toThrow(/your turn/i);
  });

  it("blocks cross-tenant and same-school non-participant access with 404", async () => {
    const g = await svc.createGame(P(u1, SA), { difficultyLength: 4 });
    // other school (SB) — RLS hides it
    await expect(svc.getGame(P(u3, SB), g.id)).rejects.toThrow(/not found/i);
    // same school, not a participant — relationship scope
    await expect(svc.getGame(P(u4, SA), g.id)).rejects.toThrow(/not found/i);
  });

  it("validates secrets through the engine", async () => {
    const g = await svc.createGame(P(u1, SA), { difficultyLength: 4 });
    await svc.joinGame(P(u2, SA), g.id);
    await expect(svc.submitSecret(P(u1, SA), g.id, "1123")).rejects.toThrow(/distinct digits/i);
  });
});
