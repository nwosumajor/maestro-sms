import { GameEventsService } from "./game-events.service";
import type { RedisPubSubService } from "../common/redis-pubsub.service";

// A minimal in-memory stand-in for RedisPubSubService that wires N "instances"
// together: publishing from one endpoint delivers ONLY to the OTHER endpoints'
// handlers (the real service skips its own echo by instance id; the producer
// delivers to itself locally). This lets us prove cross-instance fan-out and
// exactly-once delivery without a real Redis.
function makeFakeBus() {
  const endpoints: { handlers: Map<string, Set<(p: unknown) => void>> }[] = [];
  return {
    endpoint(): RedisPubSubService {
      const self = { handlers: new Map<string, Set<(p: unknown) => void>>() };
      endpoints.push(self);
      return {
        subscribe(channel: string, handler: (p: unknown) => void) {
          const set = self.handlers.get(channel) ?? new Set();
          set.add(handler);
          self.handlers.set(channel, set);
        },
        publish(channel: string, payload: unknown) {
          for (const ep of endpoints) {
            if (ep === self) continue; // producer handled it locally — skip echo
            for (const h of ep.handlers.get(channel) ?? []) h(payload);
          }
        },
      } as unknown as RedisPubSubService;
    },
  };
}

// Unit test for the in-process "game changed" pub/sub that bridges durable
// GameService commits to the live /ws/watch socket gateway (§10 live-push). The
// service carries NO game data and NO authority — just a gameId nudge — so these
// tests pin exactly that contract: deliver the id, let subscribers filter, and
// stop delivering once unsubscribed.
describe("GameEventsService", () => {
  it("delivers an emitted gameId to every active subscriber", () => {
    const events = new GameEventsService();
    const a: string[] = [];
    const b: string[] = [];
    events.onChanged((id) => a.push(id));
    events.onChanged((id) => b.push(id));

    events.emitChanged("game-1");

    expect(a).toEqual(["game-1"]);
    expect(b).toEqual(["game-1"]);
  });

  it("stops delivering after unsubscribe (socket close tears its listener down)", () => {
    const events = new GameEventsService();
    const seen: string[] = [];
    const unsubscribe = events.onChanged((id) => seen.push(id));

    events.emitChanged("game-1");
    unsubscribe();
    events.emitChanged("game-2");

    expect(seen).toEqual(["game-1"]); // game-2 arrives after teardown → not seen
  });

  it("lets a subscriber filter to the one game it watches (the gateway's job)", () => {
    const events = new GameEventsService();
    const watched: string[] = [];
    const watchedGameId = "game-42";
    events.onChanged((id) => {
      if (id === watchedGameId) watched.push(id);
    });

    events.emitChanged("game-1");
    events.emitChanged("game-42");
    events.emitChanged("game-7");

    expect(watched).toEqual(["game-42"]);
  });

  it("fans a change out to a spectator on a DIFFERENT instance (Redis bridge)", () => {
    const bus = makeFakeBus();
    const taskA = new GameEventsService(bus.endpoint());
    const taskB = new GameEventsService(bus.endpoint());
    taskA.onModuleInit();
    taskB.onModuleInit();

    const seenA: string[] = [];
    const seenB: string[] = [];
    taskA.onChanged((id) => seenA.push(id));
    taskB.onChanged((id) => seenB.push(id)); // spectator connected to task B

    // The mutation commits on task A; task B's spectator must still be nudged.
    taskA.emitChanged("game-9");

    expect(seenA).toEqual(["game-9"]); // local delivery on the producer
    expect(seenB).toEqual(["game-9"]); // cross-instance delivery via the bus
  });

  it("delivers exactly once on the producing instance (no echo double-fire)", () => {
    const bus = makeFakeBus();
    const taskA = new GameEventsService(bus.endpoint());
    new GameEventsService(bus.endpoint()).onModuleInit(); // a second task on the bus
    taskA.onModuleInit();

    const seenA: string[] = [];
    taskA.onChanged((id) => seenA.push(id));
    taskA.emitChanged("game-1");

    expect(seenA).toEqual(["game-1"]); // once — not twice from its own echo
  });
});
