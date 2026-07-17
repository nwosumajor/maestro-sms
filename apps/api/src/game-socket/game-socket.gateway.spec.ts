import { NotFoundException } from "@nestjs/common";
import { GAME_PERMISSIONS } from "@sms/types";
import { GameSocketGateway } from "./game-socket.gateway";
import { GameEventsService } from "../game/game-events.service";
import type { GamePrincipal } from "@sms/game-transport";

// =============================================================================
// Unit test for the /ws/watch security dispatch — the live-push spectator bridge.
// =============================================================================
// This is the "permission guard" category CLAUDE.md flags as most important: the
// gateway must enforce the SAME coarse permission each HTTP GET does, route each
// `mode` to its own viewer-redacted reader, and treat a relationship/RLS miss as
// 404 (never 403, no cross-tenant existence leak). We drive the private `watch`
// handler directly with a fake socket so no real ws/DB is needed.
// =============================================================================

type Frame = { type: string; code?: string; message?: string; game?: unknown };

/** Minimal stand-in for the `ws` socket: records close + fires lifecycle handlers. */
class FakeSocket {
  closed: { code: number; reason: string } | null = null;
  private handlers: Record<string, () => void> = {};
  on(event: string, cb: () => void): void {
    this.handlers[event] = cb;
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.handlers["close"]?.();
  }
  emit(event: string): void {
    this.handlers[event]?.();
  }
}

const flush = () => new Promise((r) => setImmediate(r));

interface Getters {
  game?: jest.Mock;
  ring?: jest.Mock;
  race?: jest.Mock;
  league?: jest.Mock;
  ultimate?: jest.Mock;
}

function setup(getters: Getters = {}) {
  const events = new GameEventsService();
  const durableGames = { getGame: getters.game ?? jest.fn() };
  const durableRings = { getRing: getters.ring ?? jest.fn() };
  const durableRaces = { getRace: getters.race ?? jest.fn() };
  const durableCompetitions = { get: getters.league ?? jest.fn() };
  const durableUltimate = { leaderboard: getters.ultimate ?? jest.fn() };
  const gateway = new GameSocketGateway(
    durableGames as never,
    durableRings as never,
    durableRaces as never,
    durableCompetitions as never,
    durableUltimate as never,
    events,
    { forRoles: jest.fn().mockResolvedValue([]) } as never,
  );
  const socket = new FakeSocket();
  const sent: Frame[] = [];
  const send = (m: unknown) => sent.push(m as Frame);
  const watch = (principal: GamePrincipal, gameId: string | null, mode: string | null) =>
    (
      gateway as unknown as {
        watch: (s: unknown, send: (m: unknown) => void, p: GamePrincipal, id: string | null, mode: string | null) => void;
      }
    ).watch(socket, send, principal, gameId, mode);
  return { events, durableGames, durableRings, durableRaces, durableCompetitions, durableUltimate, socket, sent, watch };
}

const principal = (permissions: string[]): GamePrincipal => ({
  userId: "u1",
  schoolId: "s1",
  roles: ["student"],
  permissions,
  name: "Ada",
});

describe("GameSocketGateway — /ws/watch security dispatch", () => {
  it("rejects an unknown mode with BAD_REQUEST and no reader call", async () => {
    const { watch, sent, socket, durableGames } = setup();
    watch(principal([GAME_PERMISSIONS.PLAY]), "g1", "bogus");
    await flush();
    expect(sent).toEqual([{ type: "error", code: "BAD_REQUEST", message: "unknown watch mode" }]);
    expect(socket.closed?.code).toBe(4400);
    expect(durableGames.getGame).not.toHaveBeenCalled();
  });

  it("forbids duel watch without game.play (4403), never reading", async () => {
    const { watch, sent, socket, durableGames } = setup();
    watch(principal([GAME_PERMISSIONS.LEADERBOARD_READ]), "g1", "duel");
    await flush();
    expect(sent[0]?.code).toBe("FORBIDDEN");
    expect(socket.closed?.code).toBe(4403);
    expect(durableGames.getGame).not.toHaveBeenCalled();
  });

  it("gates race watch on game.leaderboard.read, not game.play", async () => {
    // Holding only game.play is NOT enough to watch a race (mirrors the HTTP GET).
    const denied = setup();
    denied.watch(principal([GAME_PERMISSIONS.PLAY]), "r1", "race");
    await flush();
    expect(denied.sent[0]?.code).toBe("FORBIDDEN");
    expect(denied.durableRaces.getRace).not.toHaveBeenCalled();

    // With leaderboard.read it is allowed and routes to getRace.
    const allowed = setup({ race: jest.fn().mockResolvedValue({ id: "r1", status: "ACTIVE" }) });
    allowed.watch(principal([GAME_PERMISSIONS.LEADERBOARD_READ]), "r1", "race");
    await flush();
    expect(allowed.durableRaces.getRace).toHaveBeenCalledTimes(1);
    expect(allowed.sent.at(-1)).toEqual({ type: "state", game: { id: "r1", status: "ACTIVE" } });
  });

  it("routes league watch to the competition reader, gated on leaderboard.read", async () => {
    // The league id is a competitionId; staff/students with leaderboard.read watch it.
    const get = jest.fn().mockResolvedValue({ id: "comp1", name: "Spring League", standings: [] });
    const { watch, sent, durableCompetitions } = setup({ league: get });
    watch(principal([GAME_PERMISSIONS.LEADERBOARD_READ]), "comp1", "league");
    await flush();
    expect(durableCompetitions.get).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", schoolId: "s1" }),
      "comp1",
    );
    expect(sent.at(-1)).toEqual({
      type: "state",
      game: { id: "comp1", name: "Spring League", standings: [] },
    });
  });

  it("routes ultimate watch to the cross-school leaderboard, gated on leaderboard.read", async () => {
    // The ultimate id is the global (cross-tenant) arena competition id; the
    // reader returns the pseudonymous board (handles + school names + scores).
    const leaderboard = jest.fn().mockResolvedValue({ competitionId: "ult1", rows: [] });
    const { watch, sent, durableUltimate } = setup({ ultimate: leaderboard });
    watch(principal([GAME_PERMISSIONS.LEADERBOARD_READ]), "ult1", "ultimate");
    await flush();
    expect(durableUltimate.leaderboard).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", schoolId: "s1" }),
      "ult1",
    );
    expect(sent.at(-1)).toEqual({ type: "state", game: { competitionId: "ult1", rows: [] } });
  });

  it("forbids ultimate watch without leaderboard.read (4403)", async () => {
    const { watch, sent, socket, durableUltimate } = setup();
    watch(principal([GAME_PERMISSIONS.PLAY]), "ult1", "ultimate");
    await flush();
    expect(sent[0]?.code).toBe("FORBIDDEN");
    expect(socket.closed?.code).toBe(4403);
    expect(durableUltimate.leaderboard).not.toHaveBeenCalled();
  });

  it("requires a gameId (BAD_REQUEST)", async () => {
    const { watch, sent, socket } = setup();
    watch(principal([GAME_PERMISSIONS.PLAY]), null, "duel");
    await flush();
    expect(sent[0]?.message).toBe("gameId is required");
    expect(socket.closed?.code).toBe(4400);
  });

  it("pushes the duel view on connect, projecting identity from the token", async () => {
    const getGame = jest.fn().mockResolvedValue({ id: "g1", status: "ACTIVE" });
    const { watch, sent, durableGames } = setup({ game: getGame });
    watch(principal([GAME_PERMISSIONS.PLAY]), "g1", "duel");
    await flush();
    expect(sent).toEqual([{ type: "state", game: { id: "g1", status: "ACTIVE" } }]);
    // SECURITY: identity passed to the durable getter comes from the token only.
    expect(durableGames.getGame).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", schoolId: "s1" }),
      "g1",
    );
  });

  it("re-reads and re-pushes only when ITS game changes (filtered subscription)", async () => {
    const getRing = jest.fn().mockResolvedValue({ id: "ring1", status: "ACTIVE" });
    const { watch, sent, events, durableRings } = setup({ ring: getRing });
    watch(principal([GAME_PERMISSIONS.PLAY]), "ring1", "ring");
    await flush();
    expect(durableRings.getRing).toHaveBeenCalledTimes(1); // initial push

    events.emitChanged("other-game"); // not ours → ignored
    await flush();
    expect(durableRings.getRing).toHaveBeenCalledTimes(1);

    events.emitChanged("ring1"); // ours → re-read + re-push
    await flush();
    expect(durableRings.getRing).toHaveBeenCalledTimes(2);
    expect(sent.filter((f) => f.type === "state")).toHaveLength(2);
  });

  it("maps a relationship/RLS miss to NOT_FOUND + close (404, never 403)", async () => {
    const getGame = jest.fn().mockRejectedValue(new NotFoundException("Game not found"));
    const { watch, sent, socket } = setup({ game: getGame });
    watch(principal([GAME_PERMISSIONS.PLAY]), "g1", "duel");
    await flush();
    expect(sent.at(-1)).toEqual({ type: "error", code: "NOT_FOUND", message: "game not found" });
    expect(socket.closed?.code).toBe(4404);
  });

  it("stops re-pushing after the socket closes (unsubscribe on teardown)", async () => {
    const getGame = jest.fn().mockResolvedValue({ id: "g1", status: "ACTIVE" });
    const { watch, events, socket, durableGames } = setup({ game: getGame });
    watch(principal([GAME_PERMISSIONS.PLAY]), "g1", "duel");
    await flush();
    expect(durableGames.getGame).toHaveBeenCalledTimes(1);

    socket.emit("close"); // client disconnects → unsubscribe
    events.emitChanged("g1");
    await flush();
    expect(durableGames.getGame).toHaveBeenCalledTimes(1); // no further reads
  });

  it("defaults an absent mode to duel", async () => {
    const getGame = jest.fn().mockResolvedValue({ id: "g1", status: "LOBBY" });
    const { watch, durableGames } = setup({ game: getGame });
    watch(principal([GAME_PERMISSIONS.PLAY]), "g1", null);
    await flush();
    expect(durableGames.getGame).toHaveBeenCalledTimes(1);
  });
});
