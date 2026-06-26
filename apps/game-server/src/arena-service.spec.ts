import { generateSecret } from "@sms/game-engine";
import { ArenaService } from "./arena-service";
import type { ArenaClientMessage, ArenaServerMessage } from "./arena-protocol";

/** With rng = () => 0 every per-entry target is this known secret, so a test can
 *  crack it over the wire (the target itself is never serialized). */
const TARGET = generateSecret(4, () => 0);

class FakeClient {
  readonly received: ArenaServerMessage[] = [];
  readonly connId: string;
  arenaId: string | null = null;
  participantId: string | null = null;

  constructor(private readonly svc: ArenaService) {
    this.connId = svc.connect((m) => {
      this.received.push(m);
      if (m.type === "created") this.arenaId = m.arenaId;
      if (m.type === "entered") {
        this.arenaId = m.arenaId;
        this.participantId = m.participantId;
      }
    });
  }

  send(msg: ArenaClientMessage): void {
    this.svc.handle(this.connId, JSON.stringify(msg));
  }

  of<T extends ArenaServerMessage["type"]>(type: T): Extract<ArenaServerMessage, { type: T }>[] {
    return this.received.filter((m) => m.type === type) as Extract<ArenaServerMessage, { type: T }>[];
  }

  latestState() {
    return [...this.of("state")].pop();
  }
}

const liveServices: ArenaService[] = [];
function newService(overrides: ConstructorParameters<typeof ArenaService>[0] = {}) {
  const svc = new ArenaService({ rng: () => 0, minActionIntervalMs: 0, getReadyMs: 200, ...overrides });
  liveServices.push(svc);
  return svc;
}

describe("ArenaService — Ultimate arena orchestration (spec §7 / §11.8)", () => {
  afterEach(() => {
    for (const svc of liveServices.splice(0)) svc.shutdown();
    jest.useRealTimers();
  });

  it("create → enter → get-ready countdown → begin → crack → admin close → over", () => {
    jest.useFakeTimers();
    const svc = newService();
    const admin = new FakeClient(svc);
    admin.send({ type: "create", difficultyLength: 4 });
    const arenaId = admin.arenaId as string;

    const p = new FakeClient(svc);
    p.send({ type: "enter", arenaId, handle: "Alice" });
    expect(p.of("countdown").pop()?.remainingMs).toBe(200);
    // Cannot guess during the get-ready window.
    p.send({ type: "guess", value: TARGET });
    expect(p.of("error").pop()?.code).toBe("NOT_STARTED");

    jest.advanceTimersByTime(200); // countdown elapses → race begins
    expect(p.latestState()?.arena.yourEntry?.status).toBe("racing");

    p.send({ type: "guess", value: TARGET }); // crack own target
    expect(p.of("scored").pop()?.result).toEqual({ dead: 4, wounded: 0 });
    expect(p.latestState()?.arena.yourEntry).toMatchObject({ status: "finished", rank: 1 });

    admin.send({ type: "close" });
    const over = admin.of("over").pop();
    expect(over?.results).toHaveLength(1);
    expect(over?.results[0]).toMatchObject({ handle: "Alice", rank: 1 });
    svc.shutdown();
  });

  it("ranks finishers by the §5 metric across the arena", () => {
    jest.useFakeTimers();
    const svc = newService();
    const admin = new FakeClient(svc);
    admin.send({ type: "create", difficultyLength: 4 });
    const arenaId = admin.arenaId as string;

    const a = new FakeClient(svc);
    const b = new FakeClient(svc);
    a.send({ type: "enter", arenaId, handle: "Alice" });
    b.send({ type: "enter", arenaId, handle: "Bob" });
    jest.advanceTimersByTime(200); // both begin

    a.send({ type: "guess", value: TARGET }); // 1 guess
    b.send({ type: "guess", value: "0213" }); // wrong (distinct digits, not target)
    b.send({ type: "guess", value: TARGET }); // 2 guesses → ranks below Alice

    admin.send({ type: "close" });
    const ranks = admin.of("over").pop()!.results.map((r) => [r.handle, r.rank]);
    expect(ranks).toEqual([
      ["Alice", 1],
      ["Bob", 2],
    ]);
    svc.shutdown();
  });

  it("validates the handle and rejects a closed/duplicate entry", () => {
    const svc = newService({ getReadyMs: 10_000 });
    const admin = new FakeClient(svc);
    admin.send({ type: "create" });
    const arenaId = admin.arenaId as string;
    const p = new FakeClient(svc);
    p.send({ type: "enter", arenaId, handle: "Ax" }); // too short
    expect(p.of("error").pop()?.code).toBe("INVALID_HANDLE");
  });

  it("lets only the admin close the arena", () => {
    const svc = newService({ getReadyMs: 10_000 });
    const admin = new FakeClient(svc);
    admin.send({ type: "create" });
    const arenaId = admin.arenaId as string;
    const p = new FakeClient(svc);
    p.send({ type: "enter", arenaId, handle: "Alice" });
    p.send({ type: "close" }); // a player is not the admin
    expect(p.of("error").pop()?.code).toBe("NOT_ADMIN");
  });

  it("never serializes a per-entry target/secret on the wire", () => {
    jest.useFakeTimers();
    const svc = newService();
    const admin = new FakeClient(svc);
    admin.send({ type: "create" });
    const arenaId = admin.arenaId as string;
    const a = new FakeClient(svc);
    const b = new FakeClient(svc);
    a.send({ type: "enter", arenaId, handle: "Alice" });
    b.send({ type: "enter", arenaId, handle: "Bob" });
    jest.advanceTimersByTime(200);
    a.send({ type: "guess", value: "0213" }); // A's wrong guess (un-cracked target)

    // B never guessed the target; it must appear in no frame B receives, and no
    // target/secret field is ever serialized to anyone.
    for (const client of [admin, a, b]) {
      for (const msg of client.received) {
        expect(JSON.stringify(msg)).not.toMatch(/"secret"|"target"/);
      }
    }
    expect(b.received.some((m) => JSON.stringify(m).includes(TARGET))).toBe(false);
    svc.shutdown();
  });

  it("rate-limits rapid-fire guesses (anti-abuse §5)", () => {
    jest.useFakeTimers();
    const svc = newService({ minActionIntervalMs: 10_000 });
    const admin = new FakeClient(svc);
    admin.send({ type: "create" });
    const p = new FakeClient(svc);
    p.send({ type: "enter", arenaId: admin.arenaId as string, handle: "Alice" });
    jest.advanceTimersByTime(200);
    p.send({ type: "guess", value: "0213" }); // first ok
    p.send({ type: "guess", value: TARGET }); // immediately again → throttled
    expect(p.of("error").pop()?.code).toBe("RATE_LIMITED");
    svc.shutdown();
  });

  it("a disconnect clears the get-ready timer and does not break the arena", () => {
    jest.useFakeTimers();
    const svc = newService();
    const admin = new FakeClient(svc);
    admin.send({ type: "create" });
    const arenaId = admin.arenaId as string;

    const gone = new FakeClient(svc);
    gone.send({ type: "enter", arenaId, handle: "Ghost" });
    svc.disconnect(gone.connId); // leaves before the countdown elapses
    jest.advanceTimersByTime(200); // would have begun — but the timer was cleared

    // A fresh player can still enter and play to completion.
    const p = new FakeClient(svc);
    p.send({ type: "enter", arenaId, handle: "Alice" });
    jest.advanceTimersByTime(200);
    p.send({ type: "guess", value: TARGET });
    expect(p.latestState()?.arena.yourEntry?.status).toBe("finished");
    svc.shutdown();
  });
});
