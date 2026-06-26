import { RingService } from "./ring-service";
import type { RingClientMessage, RingServerMessage } from "./ring-protocol";

/** A test connection: captures every frame the server sends to it. */
class FakeClient {
  readonly received: RingServerMessage[] = [];
  readonly connId: string;
  ringId: string | null = null;
  playerId: string | null = null;

  constructor(private readonly svc: RingService) {
    this.connId = svc.connect((m) => {
      this.received.push(m);
      if (m.type === "joined") {
        this.ringId = m.ringId;
        this.playerId = m.playerId;
      }
    });
  }

  send(msg: RingClientMessage): void {
    this.svc.handle(this.connId, JSON.stringify(msg));
  }

  of<T extends RingServerMessage["type"]>(type: T): Extract<RingServerMessage, { type: T }>[] {
    return this.received.filter((m) => m.type === type) as Extract<RingServerMessage, { type: T }>[];
  }

  latestState() {
    return [...this.of("state")].pop();
  }
}

const liveServices: RingService[] = [];
function newService(overrides: RingServiceOptionsLike = {}) {
  const svc = new RingService(overrides);
  liveServices.push(svc);
  return svc;
}
type RingServiceOptionsLike = ConstructorParameters<typeof RingService>[0];

/** Seat three clients (Alice creates, Bob & Carol join), start, and submit
 *  secrets so the ring is ACTIVE. Ring order is alice→bob→carol→alice. */
function activeTrio(svc: RingService) {
  const a = new FakeClient(svc);
  const b = new FakeClient(svc);
  const c = new FakeClient(svc);
  a.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
  b.send({ type: "join", ringId: a.ringId as string, displayName: "Bob" });
  c.send({ type: "join", ringId: a.ringId as string, displayName: "Carol" });
  a.send({ type: "start" });
  a.send({ type: "secret", value: "1234" });
  b.send({ type: "secret", value: "5678" });
  c.send({ type: "secret", value: "9012" });
  return { a, b, c };
}

describe("RingService — server-authoritative ring orchestration (spec §4 / §11.6)", () => {
  afterEach(() => {
    for (const svc of liveServices.splice(0)) svc.shutdown();
    jest.useRealTimers();
  });

  it("plays create → join → start → secrets → cracks → over", () => {
    const svc = newService({ minActionIntervalMs: 0 });
    const { a, b, c } = activeTrio(svc);

    const state = a.latestState();
    expect(state?.ring.status).toBe("active");
    expect(state?.ring.currentTurnPlayerId).toBe(a.playerId);

    // Alice cracks Bob (5678); turn advances to Carol (Alice's re-closed target).
    a.send({ type: "guess", value: "5678" });
    expect(a.of("scored").pop()?.result).toEqual({ dead: 4, wounded: 0 });
    expect(a.latestState()?.ring.currentTurnPlayerId).toBe(c.playerId);

    // Carol cracks Alice (1234) → Carol is the last standing → winner.
    c.send({ type: "guess", value: "1234" });
    const over = c.of("over");
    expect(over).toHaveLength(1);
    expect(over[0]?.winnerId).toBe(c.playerId);
    // everyone is told it is over, with reverse-order ranks
    for (const client of [a, b, c]) expect(client.of("over")).toHaveLength(1);
    const ranks = new Map(over[0]!.results.map((r) => [r.playerId, r.rank]));
    expect(ranks.get(c.playerId as string)).toBe(1);
    expect(ranks.get(a.playerId as string)).toBe(2);
    expect(ranks.get(b.playerId as string)).toBe(3);
  });

  it("reveals an eliminated player's history ONLY to whoever cracked them (§4)", () => {
    const svc = newService({ minActionIntervalMs: 0 });
    const { a, b } = activeTrio(svc);
    a.send({ type: "guess", value: "5678" }); // Alice cracks Bob

    const aInh = a.latestState()?.ring.inheritedHistories ?? [];
    expect(aInh).toHaveLength(1);
    expect(aInh[0]?.fromPlayerId).toBe(b.playerId);
    // Bob (the eliminated player) sees no inherited history of his own.
    expect(b.latestState()?.ring.inheritedHistories ?? []).toHaveLength(0);
  });

  it("NEVER puts an un-cracked secret on the wire", () => {
    const svc = newService({ minActionIntervalMs: 0 });
    const { a, b, c } = activeTrio(svc);
    a.send({ type: "guess", value: "5678" }); // cracks Bob
    c.send({ type: "guess", value: "1234" }); // cracks Alice → Carol wins
    // Carol's secret (9012) was never guessed → must appear in no frame; and no
    // `secret` field is ever serialized.
    for (const client of [a, b, c]) {
      for (const msg of client.received) {
        const json = JSON.stringify(msg);
        expect(json).not.toContain("9012");
        expect(json).not.toMatch(/"secret"/);
      }
    }
  });

  it("enforces turn order and lets only the creator start", () => {
    const svc = newService({ minActionIntervalMs: 0 });
    const a = new FakeClient(svc);
    const b = new FakeClient(svc);
    const c = new FakeClient(svc);
    a.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    b.send({ type: "join", ringId: a.ringId as string, displayName: "Bob" });
    c.send({ type: "join", ringId: a.ringId as string, displayName: "Carol" });

    b.send({ type: "start" }); // not the creator
    expect(b.of("error").pop()?.code).toBe("NOT_CREATOR");

    a.send({ type: "start" });
    a.send({ type: "secret", value: "1234" });
    b.send({ type: "secret", value: "5678" });
    c.send({ type: "secret", value: "9012" });

    b.send({ type: "guess", value: "9012" }); // not Bob's turn (Alice starts)
    expect(b.of("error").pop()?.code).toBe("NOT_YOUR_TURN");
  });

  it("rejects acting before joining a ring", () => {
    const svc = newService();
    const a = new FakeClient(svc);
    a.send({ type: "guess", value: "1234" });
    expect(a.of("error").pop()?.code).toBe("NO_SEAT");
  });

  it("rate-limits rapid-fire gameplay actions (anti-abuse §9)", () => {
    const svc = newService({ minActionIntervalMs: 10_000 });
    const { a } = activeTrio(svc);
    a.send({ type: "guess", value: "9013" }); // first ok (misses Bob)
    a.send({ type: "guess", value: "9014" }); // immediately again → throttled
    expect(a.of("error").pop()?.code).toBe("RATE_LIMITED");
  });

  it("warns the current player before the turn deadline (§4)", () => {
    jest.useFakeTimers();
    const svc = newService({ turnMs: 1000, turnWarningMs: 200, minActionIntervalMs: 0 });
    const { a } = activeTrio(svc);
    const curId = a.latestState()!.ring.currentTurnPlayerId as string;

    jest.advanceTimersByTime(799);
    expect(a.of("turn_warning")).toHaveLength(0);
    jest.advanceTimersByTime(1);
    const warns = a.of("turn_warning");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ playerId: curId, remainingMs: 200 });
    svc.shutdown();
  });

  it("graduated-timeouts a stalling player into elimination (§4)", () => {
    jest.useFakeTimers();
    const svc = newService({ turnMs: 1000, minActionIntervalMs: 0 });
    const { a, b } = activeTrio(svc);
    const aPid = a.playerId as string;

    // Nobody guesses. Alice misses on turns 1,4,7 → forfeits on her 3rd miss.
    jest.advanceTimersByTime(1000 * 7);
    const aSeat = b.latestState()?.ring.players.find((p) => p.id === aPid);
    expect(aSeat?.eliminated).toBe(true);
    // Ring is not over — Bob & Carol remain.
    expect(b.latestState()?.ring.status).toBe("active");
    svc.shutdown();
  });

  it("forfeits an absent player after the disconnect grace window (§9)", () => {
    jest.useFakeTimers();
    const svc = newService({ disconnectGraceMs: 1000, minActionIntervalMs: 0 });
    const { a, b } = activeTrio(svc);
    const aPid = a.playerId as string;

    svc.disconnect(a.connId); // Alice drops
    expect(b.latestState()?.ring.players.find((p) => p.id === aPid)?.connected).toBe(false);

    jest.advanceTimersByTime(1001);
    expect(b.latestState()?.ring.players.find((p) => p.id === aPid)?.eliminated).toBe(true);
    svc.shutdown();
  });
});
