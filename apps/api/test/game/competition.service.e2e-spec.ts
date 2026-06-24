// =============================================================================
// CompetitionService integration — real DB, app role, RLS in force (spec §6)
// =============================================================================
// Proves the League/Knockout layer end to end against Postgres:
//   - a LEAGUE generates a full round-robin, plays out, and ranks by points then
//     fewest guesses (spec §6 scoring)
//   - a KNOCKOUT advances winners round by round to a single champion
//   - the overdue-match sweep forfeits a no-show (deadline manipulated via admin)
//   - cross-tenant access 404s (never 403)
//   - no secret is ever returned in any competition view (server authority, §9)
//
// Needs TEST_DATABASE_URL (app role; also DATABASE_URL for the Prisma singleton)
// + TEST_ADMIN_URL (superuser, to seed). Skips otherwise so it never false-passes.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { GameService } from "../../src/game/game.service";
import { CompetitionService } from "../../src/game/competition.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";
import type { CompetitionDetailDto } from "@sms/types";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("CompetitionService integration (League/Knockout, RLS, server authority)", () => {
  let admin: Pool;
  let games: GameService;
  let comps: CompetitionService;

  const SA = randomUUID();
  const SB = randomUUID();
  // Four players in SA (named by priority A>B>C>D) + one in SB.
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const D = randomUUID();
  const SB1 = randomUUID();
  const PRIORITY: string[] = [A, B, C, D];

  const P = (userId: string, schoolId: string): Principal => ({
    userId,
    schoolId,
    roles: ["principal"],
    permissions: ["game.play", "game.leaderboard.read", "game.league.create"],
  });
  const admin1 = () => P(A, SA);

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'CA',$2,now()),($3,'CB',$4,now())`,
      [SA, "ca-" + SA, SB, "cb-" + SB],
    );
    for (const [u, s, name] of [
      [A, SA, "Alice"],
      [B, SA, "Bob"],
      [C, SA, "Carol"],
      [D, SA, "Dan"],
      [SB1, SB, "Eve"],
    ] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, s, u + "@t", name],
      );
    }
    const tenant = new PrismaTenantService() as never;
    const auditSvc = new AuditLogService() as never;
    comps = new CompetitionService(tenant, auditSvc);
    games = new GameService(tenant, auditSvc, comps);
  });

  afterAll(async () => {
    for (const t of [
      "guess",
      "game_result",
      "game_player",
      "game",
      "standing",
      "competition",
      "audit_log",
    ]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, [[SA, SB]]);
    await admin.end();
    await prisma.$disconnect();
  });

  const noSecret = (v: unknown) => expect(JSON.stringify(v)).not.toContain("1234");

  // Play one competition match to completion, making `winner` win.
  async function playMatch(gameId: string, winner: string, loser: string): Promise<void> {
    const wP = P(winner, SA);
    const lP = P(loser, SA);
    await games.submitSecret(wP, gameId, "1234"); // winner's own secret
    await games.submitSecret(lP, gameId, "5678"); // loser's own secret → activates
    const view = await games.getGame(wP, gameId);
    const wPlayerId = view.players.find((pl) => pl.userId === winner)!.playerId;
    if (view.currentTurnPlayerId === wPlayerId) {
      await games.guess(wP, gameId, "5678"); // winner cracks the loser's secret → win
    } else {
      await games.guess(lP, gameId, "9087"); // loser stalls (not the winner's 1234)
      await games.guess(wP, gameId, "5678"); // winner cracks → win
    }
  }

  // Drive every playable 2-player match, making the higher-priority player win,
  // until the competition closes.
  async function playOut(reader: Principal, competitionId: string): Promise<CompetitionDetailDto> {
    let detail = await comps.get(reader, competitionId);
    for (let i = 0; i < 50 && detail.status !== "FINISHED"; i++) {
      const m = detail.matches.find(
        (mm) => (mm.status === "SETUP" || mm.status === "ACTIVE") && mm.players.length === 2,
      );
      if (!m) break;
      const pa = m.players[0]!;
      const pb = m.players[1]!;
      const winner =
        PRIORITY.indexOf(pa.userId) < PRIORITY.indexOf(pb.userId) ? pa.userId : pb.userId;
      const loser = winner === pa.userId ? pb.userId : pa.userId;
      await playMatch(m.gameId, winner, loser);
      detail = await comps.get(reader, competitionId);
    }
    return detail;
  }

  it("runs a LEAGUE: round-robin, plays out, ranks by points (3/0)", async () => {
    const created = await comps.create(admin1(), {
      type: "LEAGUE",
      name: "Spring League",
      difficultyLength: 4,
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 7 * 864e5).toISOString(),
      participantUserIds: [A, B, C],
    });
    expect(created.status).toBe("DRAFT");
    expect(created.standings).toHaveLength(3);

    const started = await comps.start(admin1(), created.id);
    expect(started.status).toBe("ACTIVE");
    // C(3,2) = 3 matchups, all awaiting secrets.
    expect(started.matches).toHaveLength(3);
    expect(started.matches.every((m) => m.status === "SETUP")).toBe(true);
    noSecret(started);

    const final = await playOut(admin1(), created.id);
    expect(final.status).toBe("FINISHED");
    const byUser = Object.fromEntries(final.standings.map((s) => [s.userId, s]));
    // A beats B and C; B beats C → A 6pts, B 3pts, C 0pts.
    expect(byUser[A]).toMatchObject({ points: 6, wins: 2, losses: 0, rank: 1 });
    expect(byUser[B]).toMatchObject({ points: 3, wins: 1, rank: 2 });
    expect(byUser[C]).toMatchObject({ points: 0, wins: 0, rank: 3 });
    noSecret(final);
  });

  it("runs a KNOCKOUT to a single champion", async () => {
    const created = await comps.create(admin1(), {
      type: "KNOCKOUT",
      name: "Cup",
      difficultyLength: 4,
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 7 * 864e5).toISOString(),
      participantUserIds: [A, B, C, D],
    });
    const started = await comps.start(admin1(), created.id);
    expect(started.status).toBe("ACTIVE");
    // 4 players → 2 first-round matches, no bye.
    const round1 = started.matches.filter((m) => m.roundNumber === 1);
    expect(round1).toHaveLength(2);

    const final = await playOut(admin1(), created.id);
    expect(final.status).toBe("FINISHED");
    // A beats everyone they meet → A is champion (rank 1, not eliminated).
    const champ = final.standings.find((s) => s.rank === 1)!;
    expect(champ.userId).toBe(A);
    expect(champ.eliminated).toBe(false);
    expect(final.standings.filter((s) => s.rank === 1)).toHaveLength(1);
  });

  it("gives a bye on an odd knockout field (3 players)", async () => {
    const created = await comps.create(admin1(), {
      type: "KNOCKOUT",
      name: "OddCup",
      difficultyLength: 4,
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 7 * 864e5).toISOString(),
      participantUserIds: [A, B, C],
    });
    const started = await comps.start(admin1(), created.id);
    // 3 players → one real match + one (pre-finished) bye match in round 1.
    const round1 = started.matches.filter((m) => m.roundNumber === 1);
    expect(round1).toHaveLength(2);
    expect(round1.filter((m) => m.players.length === 1)).toHaveLength(1); // the bye
    const final = await playOut(admin1(), created.id);
    expect(final.status).toBe("FINISHED");
    expect(final.standings.find((s) => s.rank === 1)!.userId).toBe(A);
  });

  it("forfeits a no-show when the play window closes (sweep)", async () => {
    const created = await comps.create(admin1(), {
      type: "KNOCKOUT",
      name: "Forfeit Cup",
      difficultyLength: 4,
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 7 * 864e5).toISOString(),
      participantUserIds: [A, B],
    });
    const started = await comps.start(admin1(), created.id);
    const match = started.matches.find((m) => m.players.length === 2)!;
    // Nobody plays; force the deadline into the past, then sweep.
    await admin.query(`UPDATE game SET "deadlineAt" = now() - interval '1 hour' WHERE id = $1`, [
      match.gameId,
    ]);
    const swept = await comps.sweep(admin1(), created.id);
    // Both no-showed → higher standing advances; competition closes with a winner.
    expect(swept.status).toBe("FINISHED");
    expect(swept.standings.find((s) => s.rank === 1)).toBeDefined();
    const finished = swept.matches.find((m) => m.gameId === match.gameId)!;
    expect(finished.status).toBe("FINISHED");
    expect(finished.winnerUserId).not.toBeNull();
  });

  it("blocks cross-tenant access with 404", async () => {
    const created = await comps.create(admin1(), {
      type: "LEAGUE",
      name: "Private",
      difficultyLength: 4,
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 864e5).toISOString(),
      participantUserIds: [A, B],
    });
    await expect(comps.get(P(SB1, SB), created.id)).rejects.toThrow(/not found/i);
  });

  it("rejects participants from outside the caller's school", async () => {
    await expect(
      comps.create(admin1(), {
        type: "LEAGUE",
        name: "Bad",
        difficultyLength: 4,
        startAt: new Date().toISOString(),
        endAt: new Date(Date.now() + 864e5).toISOString(),
        participantUserIds: [A, SB1], // SB1 is in another school
      }),
    ).rejects.toThrow(/your school/i);
  });
});
