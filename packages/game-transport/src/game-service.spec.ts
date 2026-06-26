import { InMemoryGameStore } from "@sms/game-engine";
import { GameService } from "./game-service";
import type { ClientMessage, ServerMessage } from "./protocol";
import type { GamePrincipal } from "./auth";

/** A test connection: captures every frame the server sends to it. */
class FakeClient {
  readonly received: ServerMessage[] = [];
  readonly connId: string;
  gameId: string | null = null;
  playerId: string | null = null;

  constructor(
    private readonly svc: GameService,
    principal?: GamePrincipal,
  ) {
    this.connId = svc.connect((m) => {
      this.received.push(m);
      if (m.type === "joined") {
        this.gameId = m.gameId;
        this.playerId = m.playerId;
      }
    }, principal);
  }

  send(msg: ClientMessage): void {
    this.svc.handle(this.connId, JSON.stringify(msg));
  }

  of<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.received.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }

  latestState() {
    return [...this.of("state")].pop();
  }
}

const liveServices: GameService[] = [];
function newService(overrides: Partial<ConstructorParameters<typeof GameService>[0]> = {}) {
  const svc = new GameService({ store: new InMemoryGameStore(), ...overrides });
  liveServices.push(svc);
  return svc;
}

describe("GameService — server-authoritative orchestration (spec §11 step 2)", () => {
  afterEach(() => {
    // Stop any pending turn/disconnect timers so the test process exits cleanly.
    for (const svc of liveServices.splice(0)) svc.shutdown();
    jest.useRealTimers();
  });

  it("plays a full create → join → secrets → guess → win → over flow", () => {
    const svc = newService();
    const a = new FakeClient(svc);
    const b = new FakeClient(svc);

    a.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    b.send({ type: "join", gameId: a.gameId as string, displayName: "Bob" });
    expect(a.gameId).toBe(b.gameId);

    const secretOf = new Map<string, string>([
      [a.playerId as string, "1234"],
      [b.playerId as string, "5678"],
    ]);
    a.send({ type: "secret", value: "1234" });
    b.send({ type: "secret", value: "5678" });

    // Game is active; play data-driven by whose turn it is (first mover random).
    const state = a.latestState();
    expect(state?.game.status).toBe("active");
    const clientById = new Map([
      [a.playerId, a],
      [b.playerId, b],
    ]);
    const curId = state!.game.currentTurnPlayerId as string;
    const cur = clientById.get(curId)!;
    const opp = cur === a ? b : a;

    // Current player makes a deliberately non-winning guess; turn passes.
    cur.send({ type: "guess", value: "9013" });
    expect(a.latestState()?.game.currentTurnPlayerId).toBe(opp.playerId);

    // Opponent cracks the current player's secret → wins.
    opp.send({ type: "guess", value: secretOf.get(cur.playerId as string) as string });

    const over = opp.of("over");
    expect(over).toHaveLength(1);
    expect(over[0]?.winnerId).toBe(opp.playerId);
    // both players are told the game is over
    expect(a.of("over")).toHaveLength(1);
    expect(b.of("over")).toHaveLength(1);
    // the cracking player got their score frame
    expect(opp.of("scored").pop()?.result).toEqual({ dead: 4, wounded: 0 });
  });

  it("NEVER sends a secret to a client while the game is live (server authority)", () => {
    const svc = newService();
    const a = new FakeClient(svc);
    const b = new FakeClient(svc);
    a.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    b.send({ type: "join", gameId: a.gameId as string, displayName: "Bob" });
    a.send({ type: "secret", value: "1234" });
    b.send({ type: "secret", value: "5678" });

    // make a few non-winning moves
    const st = a.latestState()!.game;
    const cur = st.currentTurnPlayerId === a.playerId ? a : b;
    cur.send({ type: "guess", value: "9013" });

    for (const client of [a, b]) {
      for (const msg of client.received) {
        // any non-finished state frame must not contain either secret
        if (msg.type === "state" && msg.game.status !== "finished") {
          const json = JSON.stringify(msg);
          expect(json).not.toContain("1234");
          expect(json).not.toContain("5678");
        }
      }
    }
  });

  it("enforces turns and validates input through the engine", () => {
    const svc = newService();
    const a = new FakeClient(svc);
    const b = new FakeClient(svc);
    a.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    b.send({ type: "join", gameId: a.gameId as string, displayName: "Bob" });

    // invalid secret rejected
    a.send({ type: "secret", value: "1123" });
    expect(a.of("error").pop()?.code).toBe("INVALID_SECRET");

    a.send({ type: "secret", value: "1234" });
    b.send({ type: "secret", value: "5678" });

    const st = a.latestState()!.game;
    const notTurn = st.currentTurnPlayerId === a.playerId ? b : a;
    notTurn.send({ type: "guess", value: "1234" });
    expect(notTurn.of("error").pop()?.code).toBe("NOT_YOUR_TURN");
  });

  it("rejects acting before joining a game", () => {
    const svc = newService();
    const a = new FakeClient(svc);
    a.send({ type: "guess", value: "1234" });
    expect(a.of("error").pop()?.code).toBe("NO_SEAT");
  });

  it("returns a structured error on malformed frames", () => {
    const svc = newService();
    const a = new FakeClient(svc);
    svc.handle(a.connId, "not json");
    expect(a.of("error").pop()?.code).toBe("BAD_MESSAGE");
    svc.handle(a.connId, JSON.stringify({ type: "nope" }));
    expect(a.of("error").pop()?.code).toBe("BAD_MESSAGE");
  });

  it("rate-limits rapid-fire gameplay actions (anti-abuse §9)", () => {
    const svc = newService({ minActionIntervalMs: 10_000 });
    const a = new FakeClient(svc);
    const b = new FakeClient(svc);
    a.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    b.send({ type: "join", gameId: a.gameId as string, displayName: "Bob" });
    a.send({ type: "secret", value: "1234" });
    b.send({ type: "secret", value: "5678" });

    const st = a.latestState()!.game;
    const cur = st.currentTurnPlayerId === a.playerId ? a : b;
    cur.send({ type: "guess", value: "9013" }); // first ok
    cur.send({ type: "guess", value: "9014" }); // immediately again → throttled
    expect(cur.of("error").pop()?.code).toBe("RATE_LIMITED");
  });

  it("forfeits the absent player after the disconnect grace window (§9)", () => {
    jest.useFakeTimers();
    const svc = newService({ disconnectGraceMs: 1000 });
    const a = new FakeClient(svc);
    const b = new FakeClient(svc);
    a.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    b.send({ type: "join", gameId: a.gameId as string, displayName: "Bob" });
    a.send({ type: "secret", value: "1234" });
    b.send({ type: "secret", value: "5678" });

    svc.disconnect(a.connId); // Alice drops
    expect(b.latestState()?.game.players.find((p) => p.id === a.playerId)?.connected).toBe(false);

    jest.advanceTimersByTime(1001);
    const over = b.of("over");
    expect(over).toHaveLength(1);
    expect(over[0]?.winnerId).toBe(b.playerId); // Bob wins by Alice's forfeit
  });

  it("warns the current player 15s before the turn deadline (§4)", () => {
    jest.useFakeTimers();
    const svc = newService({ turnMs: 1000, turnWarningMs: 200 });
    const a = new FakeClient(svc);
    const b = new FakeClient(svc);
    a.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    b.send({ type: "join", gameId: a.gameId as string, displayName: "Bob" });
    a.send({ type: "secret", value: "1234" });
    b.send({ type: "secret", value: "5678" });

    const curId = a.latestState()!.game.currentTurnPlayerId as string;

    // Nothing fires before the warning window opens (1000 - 200 = 800ms in).
    jest.advanceTimersByTime(799);
    expect(a.of("turn_warning")).toHaveLength(0);

    // At the window, BOTH players are told whose turn is running out.
    jest.advanceTimersByTime(1);
    for (const client of [a, b]) {
      const warns = client.of("turn_warning");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.playerId).toBe(curId);
      expect(warns[0]?.remainingMs).toBe(200);
    }
    svc.shutdown();
  });

  it("does not warn once the turn has already passed", () => {
    jest.useFakeTimers();
    const svc = newService({ turnMs: 1000, turnWarningMs: 200 });
    const a = new FakeClient(svc);
    const b = new FakeClient(svc);
    a.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    b.send({ type: "join", gameId: a.gameId as string, displayName: "Bob" });
    a.send({ type: "secret", value: "1234" });
    b.send({ type: "secret", value: "5678" });

    // The current player guesses (non-winning) well before the warning, passing
    // the turn — the pending warning for the old turn must be cancelled.
    const st = a.latestState()!.game;
    const cur = st.currentTurnPlayerId === a.playerId ? a : b;
    jest.advanceTimersByTime(100);
    cur.send({ type: "guess", value: "9013" });
    jest.advanceTimersByTime(701); // crosses the original 800ms warning mark

    // Only the NEW turn's warning may exist, and never one naming the player who
    // already moved.
    for (const client of [a, b]) {
      for (const w of client.of("turn_warning")) {
        expect(w.playerId).not.toBe(cur.playerId);
      }
    }
    svc.shutdown();
  });

  it("uses the verified identity for the display name when authenticated", () => {
    const svc = newService();
    const ada: GamePrincipal = { userId: "u1", schoolId: "s1", roles: ["student"], name: "Ada" };
    const a = new FakeClient(svc, ada);
    // The client tries to spoof a different name; the token's name wins.
    a.send({ type: "create", difficultyLength: 4, displayName: "Imposter" });
    const names = a.latestState()?.game.players.map((p) => p.displayName);
    expect(names).toEqual(["Ada"]);
  });

  it("enforces tenant isolation — a different school cannot join (404 not 403)", () => {
    const svc = newService();
    const host: GamePrincipal = { userId: "u1", schoolId: "school-A", roles: [], name: "Ada" };
    const sameSchool: GamePrincipal = { userId: "u2", schoolId: "school-A", roles: [], name: "Bob" };
    const otherSchool: GamePrincipal = { userId: "u3", schoolId: "school-B", roles: [], name: "Eve" };

    const a = new FakeClient(svc, host);
    a.send({ type: "create", difficultyLength: 4 });
    const gameId = a.gameId as string;

    const eve = new FakeClient(svc, otherSchool);
    eve.send({ type: "join", gameId });
    // Cross-tenant join is indistinguishable from a non-existent game.
    expect(eve.of("error").pop()?.code).toBe("GAME_NOT_FOUND");

    const bob = new FakeClient(svc, sameSchool);
    bob.send({ type: "join", gameId });
    expect(bob.of("error")).toHaveLength(0);
    expect(bob.gameId).toBe(gameId);
  });

  it("keeps tenant isolation after the game has FINISHED (no existence leak)", () => {
    const svc = newService();
    const host: GamePrincipal = { userId: "u1", schoolId: "school-A", roles: [], name: "Ada" };
    const opp: GamePrincipal = { userId: "u2", schoolId: "school-A", roles: [], name: "Bob" };
    const a = new FakeClient(svc, host);
    const b = new FakeClient(svc, opp);
    a.send({ type: "create", difficultyLength: 4 });
    const gameId = a.gameId as string;
    b.send({ type: "join", gameId });
    a.send({ type: "secret", value: "1234" });
    b.send({ type: "secret", value: "5678" });
    // Play to a finish.
    const st = a.latestState()!.game;
    const secretOf: Record<string, string> = { [a.playerId as string]: "1234", [b.playerId as string]: "5678" };
    const cur = st.currentTurnPlayerId === a.playerId ? a : b;
    const opc = cur === a ? b : a;
    cur.send({ type: "guess", value: "9013" });
    opc.send({ type: "guess", value: secretOf[cur.playerId as string] as string });
    expect(a.latestState()?.game.status).toBe("finished");

    // A cross-tenant late join of the FINISHED game must still be a clean 404,
    // never FULL/NOT_LOBBY (which would disclose the game's existence).
    const eve = new FakeClient(svc, { userId: "u9", schoolId: "school-B", roles: [], name: "Eve" });
    eve.send({ type: "join", gameId });
    expect(eve.of("error").pop()?.code).toBe("GAME_NOT_FOUND");
  });

  it("times out a stalling turn and eventually forfeits (§9 graduated)", () => {
    jest.useFakeTimers();
    const svc = newService({ turnMs: 1000 });
    const a = new FakeClient(svc);
    const b = new FakeClient(svc);
    a.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    b.send({ type: "join", gameId: a.gameId as string, displayName: "Bob" });
    a.send({ type: "secret", value: "1234" });
    b.send({ type: "secret", value: "5678" });

    // Nobody guesses. Default maxConsecutiveMisses=3 → first mover forfeits on
    // their 3rd consecutive miss (turns alternate on each timeout → 5 timeouts).
    jest.advanceTimersByTime(1000 * 6);
    const overA = a.of("over");
    expect(overA).toHaveLength(1);
    expect(a.of("over")[0]?.winnerId).toBeDefined();
    svc.shutdown();
  });
});
