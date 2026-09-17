// =============================================================================
// The duel you opened, could not see, and could not withdraw
// =============================================================================
// `listOpenGames` dropped the caller's own lobby — right for a list titled
// "games you can JOIN", and it left a player's own open duel visible on NO
// screen anywhere. So a duel opened by mistake, or one nobody ever joined, sat
// in every other pupil's list indefinitely with its host unable to see it, let
// alone close it. A create with no undo, on a list that only grows.
//
// The only way to close one was `POST /games/:id/end`, gated on
// `game.match.moderate` — a teacher. Withdrawing a lobby nobody has joined is
// tidying up after yourself, not moderation, so it is the host's to do.
//
// THE NARROWING IS THE POINT, and it is where this could have gone wrong: the
// host may cancel ONLY while the lobby still has one seat. The moment somebody
// joins there is an opponent with a stake in the game, and closing it is a
// moderation decision again.
// =============================================================================

import { ConflictException, NotFoundException } from "@nestjs/common";
import { GameService } from "../../src/game/game.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const HOST = "u-host";
const OTHER = "u-other";

function makeService(opts: { status?: string; seats?: string[]; games?: { id: string; host: string }[] } = {}) {
  const status = opts.status ?? "LOBBY";
  const seats = opts.seats ?? [HOST];
  const games = opts.games ?? [];
  const updated: Record<string, unknown>[] = [];

  const tx = {
    game: {
      findFirst: jest.fn(async () => ({
        id: "g1",
        schoolId: "S",
        status,
        mode: "DUEL",
        difficultyLength: 4,
        createdAt: new Date(),
        currentTurnPlayerId: null,
      })),
      findMany: jest.fn(async () =>
        games.map((g) => ({ id: g.id, difficultyLength: 4, createdAt: new Date(), status: "LOBBY", mode: "DUEL" })),
      ),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => {
        updated.push(a.data);
        return { id: "g1" };
      }),
    },
    gamePlayer: {
      // HONOURS `where.gameId.in` — a stub answering every query with the same
      // seats would make a two-seat game look open and vice versa.
      findMany: jest.fn(async (a?: { where?: { gameId?: string | { in?: string[] } } }) => {
        const where = a?.where?.gameId;
        if (where && typeof where === "object" && Array.isArray(where.in)) {
          return games
            .filter((g) => where.in!.includes(g.id))
            .map((g) => ({ gameId: g.id, userId: g.host }));
        }
        return seats.map((userId, i) => ({ id: `p${i}`, gameId: "g1", userId, secret: null, joinedAt: new Date() }));
      }),
      updateMany: jest.fn(async () => ({ count: seats.length })),
      findFirst: jest.fn(async () => null),
    },
    user: {
      findMany: jest.fn(async (a: { where: { id: { in: string[] } } }) =>
        a.where.id.in.map((id) => ({ id, name: id === HOST ? "Ada" : "Bolu" })),
      ),
      findFirst: jest.fn(async () => ({ name: "Ada" })),
    },
    guess: { findMany: jest.fn(async () => []) },
    gameResult: { findFirst: jest.fn(async () => null) },
    auditLog: { create: jest.fn() },
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const svc = new GameService(
    db as never,
    { record: jest.fn() } as never,
    { afterMatchFinished: jest.fn() } as never,
    { emitChanged: jest.fn(), emitGameAndCompetition: jest.fn() } as never,
  );
  return { svc, tx, updated };
}

const p = (userId: string): Principal => ({
  schoolId: "S",
  userId,
  roles: ["student"],
  permissions: ["game.play", "game.leaderboard.read"],
});

describe("a host can see their own waiting duel", () => {
  it("returns it, FLAGGED, instead of hiding it", async () => {
    const { svc } = makeService({
      games: [
        { id: "mine", host: HOST },
        { id: "theirs", host: OTHER },
      ],
    });
    const list = await svc.listOpenGames(p(HOST));
    expect(list.map((g) => [g.id, g.mine])).toEqual([
      ["mine", true],
      ["theirs", false],
    ]);
  });

  it("resolves the host names in ONE query, not one per game", async () => {
    // A name lookup inside the loop is a query multiplier: 100 lobbies meant 100
    // extra round trips on the games hub, plus 100 more for the seats.
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, host: i % 2 ? HOST : OTHER }));
    const { svc, tx } = makeService({ games: many });
    await svc.listOpenGames(p(HOST));
    expect((tx.user.findMany as jest.Mock).mock.calls).toHaveLength(1);
    expect((tx.user.findFirst as jest.Mock).mock.calls).toHaveLength(0);
    // Seats too: one query for every game, not one each.
    expect((tx.gamePlayer.findMany as jest.Mock).mock.calls).toHaveLength(1);
  });
});

describe("withdrawing one", () => {
  it("lets the HOST cancel a lobby nobody has joined", async () => {
    const { svc, updated } = makeService({ status: "LOBBY", seats: [HOST] });
    await svc.cancelOwnGame(p(HOST), "g1");
    expect(updated[0]).toMatchObject({ status: "ABANDONED", currentTurnPlayerId: null });
  });

  it("REFUSES once somebody has joined, and says where to go", async () => {
    // There is an opponent with a stake in it now; closing it is a teacher's
    // call. The refusal names that rather than just saying no.
    const { svc } = makeService({ status: "LOBBY", seats: [HOST, OTHER] });
    await expect(svc.cancelOwnGame(p(HOST), "g1")).rejects.toThrow(/ask a teacher/i);
  });

  it("REFUSES once the game has started", async () => {
    const { svc } = makeService({ status: "ACTIVE", seats: [HOST, OTHER] });
    await expect(svc.cancelOwnGame(p(HOST), "g1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("404s a player who has no seat, rather than confirming the game exists", async () => {
    // 404-not-403: a refusal must never confirm what it hides.
    const { svc } = makeService({ status: "LOBBY", seats: [HOST] });
    await expect(svc.cancelOwnGame(p("u-stranger"), "g1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("clears the secret when it closes the game", async () => {
    // Retention: a finished game keeps no secrets, the same as every other path
    // that closes one.
    const { svc, tx } = makeService({ status: "LOBBY", seats: [HOST] });
    await svc.cancelOwnGame(p(HOST), "g1");
    expect((tx.gamePlayer.updateMany as jest.Mock).mock.calls[0][0]).toMatchObject({
      data: { secret: null },
    });
  });
});
