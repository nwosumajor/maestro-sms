// =============================================================================
// RingService integration — real DB, app role, RLS in force (spec §4)
// =============================================================================
// Proves the Elimination Ring end to end against Postgres:
//   - a ring forms (join order → targeting), turn order is server-enforced
//   - a crack eliminates the target, the ring RE-CLOSES, and the cracker INHERITS
//     the eliminated player's guess history (§4) — but ONLY that cracker
//   - last player standing wins; placings are recorded; secrets cleared on finish
//   - secrets are NEVER serialized to any client (server authority, §9)
//   - the 60s turn limit is server-validated; a 3rd consecutive timeout forfeits
//   - cross-tenant AND same-school non-participant access both 404
//
// Needs TEST_DATABASE_URL (app role; also DATABASE_URL for the Prisma singleton)
// + TEST_ADMIN_URL (superuser, to seed). Skips otherwise so it never false-passes.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { RingService } from "../../src/game/ring.service";
import { GameEventsService } from "../../src/game/game-events.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";
import type { RingDto } from "@sms/types";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("RingService integration (Elimination Ring, RLS, server authority)", () => {
  let admin: Pool;
  let svc: RingService;

  const SA = randomUUID();
  const SB = randomUUID();
  const U1 = randomUUID();
  const U2 = randomUUID();
  const U3 = randomUUID();
  const U4 = randomUUID(); // SA non-participant
  const UB = randomUUID(); // other tenant

  const P = (userId: string, schoolId = SA): Principal => ({
    userId,
    schoolId,
    roles: ["student"],
    permissions: ["game.play"],
  });
  const playerId = (v: RingDto, userId: string) => v.players.find((pl) => pl.userId === userId)!.playerId;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'KA',$2,now()),($3,'KB',$4,now())`,
      [SA, "ka-" + SA, SB, "kb-" + SB],
    );
    for (const [u, s, name] of [
      [U1, SA, "One"],
      [U2, SA, "Two"],
      [U3, SA, "Three"],
      [U4, SA, "Four"],
      [UB, SB, "Other"],
    ] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, s, u + "@t", name],
      );
    }
    svc = new RingService(new PrismaTenantService() as never, new AuditLogService() as never, new GameEventsService());
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

  /** Open + fill + start a 3-player ring with known secrets; returns it ACTIVE. */
  async function activeRing(): Promise<RingDto> {
    const opened = await svc.openRing(P(U1), { difficultyLength: 4 });
    await svc.joinRing(P(U2), opened.id);
    await svc.joinRing(P(U3), opened.id);
    await svc.startRing(P(U1), opened.id);
    await svc.submitSecret(P(U1), opened.id, "1234");
    await svc.submitSecret(P(U2), opened.id, "5678");
    return svc.submitSecret(P(U3), opened.id, "9012"); // all in → ACTIVE
  }

  it("forms the ring, enforces turn order, re-closes on a crack, grants inherited history, and crowns a winner", async () => {
    const ring = await activeRing();
    const id = ring.id;
    expect(ring.status).toBe("ACTIVE");
    // Join order U1→U2→U3→U1; U1 starts.
    expect(ring.currentTurnPlayerId).toBe(playerId(ring, U1));
    // SECURITY: no secret leaks in the live view.
    const json = JSON.stringify(ring);
    for (const s of ["1234", "5678", "9012"]) expect(json).not.toContain(s);

    // Turn order: U2 cannot guess on U1's turn.
    await expect(svc.guess(P(U2), id, "3456")).rejects.toThrow(/your turn/i);

    // One lap of misses (each targets the next; values miss their target).
    await svc.guess(P(U1), id, "0987"); // U1 → U2(5678): miss
    await svc.guess(P(U2), id, "3456"); // U2 → U3(9012): miss
    await svc.guess(P(U3), id, "5670"); // U3 → U1(1234): miss

    // U1 cracks U2 → U2 eliminated, ring re-closes (U1 now targets U3).
    expect(await svc.guess(P(U1), id, "5678")).toEqual({ dead: 4, wounded: 0 });

    const afterCrack = await svc.getRing(P(U1), id);
    const u2pid = playerId(afterCrack, U2);
    expect(afterCrack.players.find((pl) => pl.userId === U2)!.eliminated).toBe(true);
    // U1's turn ended; play advanced to U3 (U1's re-closed target).
    expect(afterCrack.currentTurnPlayerId).toBe(playerId(afterCrack, U3));
    // Inherited history: U1 sees U2's one guess ("3456"); nobody else's.
    expect(afterCrack.inheritedHistories).toHaveLength(1);
    expect(afterCrack.inheritedHistories[0]!.fromPlayerId).toBe(u2pid);
    expect(afterCrack.inheritedHistories[0]!.guesses.map((g) => g.value)).toEqual(["3456"]);

    // U3 does NOT inherit U2's history (only the cracker does).
    const u3view = await svc.getRing(P(U3), id);
    expect(u3view.inheritedHistories).toHaveLength(0);
    expect(u3view.yourGuesses.map((g) => g.value)).toEqual(["5670"]);

    // U3 cracks U1 → only U3 remains → U3 wins.
    await svc.guess(P(U3), id, "1234");
    const final = await svc.getRing(P(U3), id);
    expect(final.status).toBe("FINISHED");
    expect(final.winnerPlayerId).toBe(playerId(final, U3));
    const rankByUser = Object.fromEntries(final.players.map((pl) => [pl.userId, pl.rank]));
    expect(rankByUser[U3]).toBe(1); // winner
    expect(rankByUser[U1]).toBe(2); // last eliminated
    expect(rankByUser[U2]).toBe(3); // first out

    // Retention: all secrets cleared in the DB once finished.
    const secrets = await admin.query<{ secret: string | null }>(
      `SELECT secret FROM game_player WHERE "gameId" = $1`,
      [id],
    );
    expect(secrets.rows.every((r) => r.secret === null)).toBe(true);
  });

  it("validates the 60s turn limit and forfeits on the third consecutive timeout", async () => {
    const ring = await activeRing();
    const id = ring.id;
    const current = ring.currentTurnPlayerId!; // U1

    // Not yet expired → rejected.
    await expect(svc.timeoutTurn(P(U2), id)).rejects.toThrow(/not expired/i);

    // Force the window closed and put the current player on their 3rd strike.
    await admin.query(`UPDATE game SET "turnStartedAt" = now() - interval '61 seconds' WHERE id = $1`, [id]);
    await admin.query(`UPDATE game_player SET "consecutiveMisses" = 2 WHERE id = $1`, [current]);

    const after = await svc.timeoutTurn(P(U2), id); // 3rd miss → forfeit
    const currentUser = ring.players.find((pl) => pl.playerId === current)!.userId;
    expect(after.players.find((pl) => pl.userId === currentUser)!.eliminated).toBe(true);
  });

  it("requires at least three players to start", async () => {
    const opened = await svc.openRing(P(U1), { difficultyLength: 4 });
    await svc.joinRing(P(U2), opened.id); // only 2 total
    await expect(svc.startRing(P(U1), opened.id)).rejects.toThrow(/at least 3/i);
  });

  it("blocks cross-tenant and same-school non-participant access with 404", async () => {
    const ring = await activeRing();
    await expect(svc.getRing(P(UB, SB), ring.id)).rejects.toThrow(/not found/i); // other tenant
    await expect(svc.getRing(P(U4), ring.id)).rejects.toThrow(/not found/i); // not a participant
  });
});
