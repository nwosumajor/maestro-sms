import { InMemoryGameStore } from "@sms/game-engine";
import { GameService } from "./game-service";
import type { ClientMessage, ServerMessage } from "./protocol";

/** A test connection: captures every frame the server sends to it. */
class FakeClient {
  readonly received: ServerMessage[] = [];
  readonly connId: string;
  gameId: string | null = null;
  playerId: string | null = null;

  constructor(private readonly svc: GameService) {
    this.connId = svc.connect((m) => {
      this.received.push(m);
      if (m.type === "joined") {
        this.gameId = m.gameId;
        this.playerId = m.playerId;
      }
    });
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
