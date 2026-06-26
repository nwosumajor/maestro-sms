import { GameEventsService } from "./game-events.service";

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
});
