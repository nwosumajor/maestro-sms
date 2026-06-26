import { generateSecret } from "@sms/game-engine";
import { RaceService } from "./race-service";
import type { RaceClientMessage, RaceServerMessage } from "./race-protocol";

/** The deterministic target the service generates when seeded with rng = () => 0,
 *  so a test can actually crack it over the wire (the target itself never leaks). */
const TARGET = generateSecret(4, () => 0);
const WRONG = TARGET.split("").reverse().join("") === TARGET ? "0123" : TARGET.split("").reverse().join("");

/** A test connection: captures every frame the server sends to it. */
class FakeClient {
  readonly received: RaceServerMessage[] = [];
  readonly connId: string;
  raceId: string | null = null;
  playerId: string | null = null;

  constructor(private readonly svc: RaceService) {
    this.connId = svc.connect((m) => {
      this.received.push(m);
      if (m.type === "joined") {
        this.raceId = m.raceId;
        this.playerId = m.playerId;
      }
    });
  }

  send(msg: RaceClientMessage): void {
    this.svc.handle(this.connId, JSON.stringify(msg));
  }

  of<T extends RaceServerMessage["type"]>(type: T): Extract<RaceServerMessage, { type: T }>[] {
    return this.received.filter((m) => m.type === type) as Extract<RaceServerMessage, { type: T }>[];
  }

  latestState() {
    return [...this.of("state")].pop();
  }
}

const liveServices: RaceService[] = [];
function newService(overrides: ConstructorParameters<typeof RaceService>[0] = {}) {
  // Seed the target deterministically so tests can crack it; default no throttle.
  const svc = new RaceService({ rng: () => 0, minActionIntervalMs: 0, ...overrides });
  liveServices.push(svc);
  return svc;
}

/** Host A creates, the named others join, A starts → race is ACTIVE. */
function activeRace(svc: RaceService, others: string[] = ["Bob", "Carol"]) {
  const a = new FakeClient(svc);
  a.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
  const rest = others.map((name) => {
    const c = new FakeClient(svc);
    c.send({ type: "join", raceId: a.raceId as string, displayName: name });
    return c;
  });
  a.send({ type: "start" });
  return { a, rest };
}

describe("RaceService — server-authoritative race orchestration (spec §5 / §11.5)", () => {
  afterEach(() => {
    for (const svc of liveServices.splice(0)) svc.shutdown();
  });

  it("plays create → join → start → parallel cracks → ranked over", () => {
    const svc = newService();
    const { a, rest } = activeRace(svc, ["Bob", "Carol", "Dave"]);
    const [b, c, d] = rest;
    expect(a.latestState()?.race.status).toBe("active");
    expect(a.latestState()?.race.participantCount).toBe(4);

    a!.send({ type: "guess", value: TARGET }); // Alice cracks → rank 1
    b!.send({ type: "guess", value: TARGET }); // Bob → rank 2
    expect(a.latestState()?.race.status).toBe("active");
    c!.send({ type: "guess", value: TARGET }); // Carol → rank 3 → race over

    expect(a.of("scored").pop()?.result).toEqual({ dead: 4, wounded: 0 });
    const over = a.of("over").pop();
    expect(over?.winnerId).toBe(a.playerId);
    const ranks = new Map(over!.results.map((r) => [r.playerId, r.rank]));
    expect(ranks.get(a.playerId as string)).toBe(1);
    expect(ranks.get(b!.playerId as string)).toBe(2);
    expect(ranks.get(c!.playerId as string)).toBe(3);
    // Dave never finished; the race ended at the third finisher.
    expect(over!.results).toHaveLength(3);
    d!.send({ type: "guess", value: TARGET });
    expect(d!.of("error").pop()?.code).toBe("NOT_ACTIVE");
  });

  it("reveals to each racer ONLY their own guesses; never the target", () => {
    const svc = newService();
    const { a, rest } = activeRace(svc);
    const [b] = rest;
    a.send({ type: "guess", value: WRONG });
    expect(b!.latestState()?.race.yourGuesses ?? []).toHaveLength(0);
    // The un-cracked target appears in no frame, and no target/secret field exists.
    for (const client of [a, b!]) {
      for (const msg of client.received) {
        const json = JSON.stringify(msg);
        expect(json).not.toContain(TARGET);
        expect(json).not.toMatch(/"target"|"secret"/);
      }
    }
  });

  it("lets only the host start and end the race", () => {
    const svc = newService();
    const a = new FakeClient(svc);
    const b = new FakeClient(svc);
    a.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    b.send({ type: "join", raceId: a.raceId as string, displayName: "Bob" });

    b.send({ type: "start" });
    expect(b.of("error").pop()?.code).toBe("NOT_HOST");
    a.send({ type: "start" });
    b.send({ type: "end" });
    expect(b.of("error").pop()?.code).toBe("NOT_HOST");

    a.send({ type: "end" });
    expect(a.of("over")).toHaveLength(1);
    expect(a.latestState()?.race.status).toBe("finished");
  });

  it("rejects guessing before joining, and before the race starts", () => {
    const svc = newService();
    const a = new FakeClient(svc);
    a.send({ type: "guess", value: TARGET });
    expect(a.of("error").pop()?.code).toBe("NO_SEAT");

    a.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    a.send({ type: "guess", value: TARGET }); // lobby, not active
    expect(a.of("error").pop()?.code).toBe("NOT_ACTIVE");
  });

  it("rate-limits rapid-fire guesses (anti-abuse §5)", () => {
    const svc = newService({ minActionIntervalMs: 10_000 });
    const { a } = activeRace(svc);
    a.send({ type: "guess", value: WRONG }); // first ok
    a.send({ type: "guess", value: TARGET }); // immediately again → throttled
    expect(a.of("error").pop()?.code).toBe("RATE_LIMITED");
  });

  it("flags a disconnected racer but does NOT forfeit (race plays on)", () => {
    const svc = newService();
    const { a, rest } = activeRace(svc);
    const [b] = rest;
    svc.disconnect(a.connId);
    expect(b!.latestState()?.race.status).toBe("active");
    b!.send({ type: "guess", value: WRONG });
    expect(b!.of("scored")).toHaveLength(1);
  });

  it("ends with an empty result set when the host ends before any crack", () => {
    const svc = newService();
    const { a } = activeRace(svc);
    a.send({ type: "end" });
    const over = a.of("over").pop();
    expect(over?.winnerId).toBeNull();
    expect(over?.results).toEqual([]);
  });
});
