import { WebSocket } from "ws";
import { createGameServer, type RunningGameServer } from "./server";
import type { ClientMessage, ServerMessage } from "./protocol";

/** A real WebSocket client wrapper with a typed `wait(...)` helper. */
function connectClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: ServerMessage[] = [];
  const waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> =
    [];

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as ServerMessage;
    received.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i] as (typeof waiters)[number];
      if (w.pred(msg)) {
        w.resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    ws,
    received,
    opened: new Promise<void>((resolve) => ws.on("open", () => resolve())),
    send: (m: ClientMessage) => ws.send(JSON.stringify(m)),
    wait<T extends ServerMessage["type"]>(
      type: T,
      pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    ): Promise<Extract<ServerMessage, { type: T }>> {
      const match = (m: ServerMessage): m is Extract<ServerMessage, { type: T }> =>
        m.type === type && pred(m as Extract<ServerMessage, { type: T }>);
      const existing = received.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) =>
        waiters.push({ pred: match, resolve: (m) => resolve(m as Extract<ServerMessage, { type: T }>) }),
      );
    },
  };
}

describe("game-server over real WebSockets (spec §11 step 2, §9 real-time)", () => {
  let server: RunningGameServer;
  afterEach(async () => {
    if (server) await server.close();
  });

  it("plays a full 2-player game and never puts a secret on the wire", async () => {
    server = createGameServer({ port: 0 });
    const port = server.port();
    const A = connectClient(port);
    const B = connectClient(port);
    await Promise.all([A.opened, B.opened]);

    A.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    const aJoined = await A.wait("joined");
    B.send({ type: "join", gameId: aJoined.gameId, displayName: "Bob" });
    const bJoined = await B.wait("joined");

    A.send({ type: "secret", value: "1234" });
    B.send({ type: "secret", value: "5678" });

    const active = await A.wait("state", (m) => m.game.status === "active");
    const curId = active.game.currentTurnPlayerId as string;
    const cur = curId === aJoined.playerId ? A : B;
    const opp = cur === A ? B : A;
    const oppPid = cur === A ? bJoined.playerId : aJoined.playerId;
    const curSecret = curId === aJoined.playerId ? "1234" : "5678";

    // Current player makes a non-winning guess; wait for the turn to pass.
    cur.send({ type: "guess", value: "9013" });
    await opp.wait("state", (m) => m.game.currentTurnPlayerId === oppPid);

    // Opponent cracks the current player's secret → wins.
    opp.send({ type: "guess", value: curSecret });
    const over = await opp.wait("over");
    expect(over.winnerId).toBe(oppPid);

    // SECURITY: no secret ever appeared in a non-finished frame on either client.
    for (const client of [A, B]) {
      for (const msg of client.received) {
        if (msg.type === "state" && msg.game.status !== "finished") {
          const json = JSON.stringify(msg);
          expect(json).not.toContain("1234");
          expect(json).not.toContain("5678");
        }
      }
    }

    A.ws.close();
    B.ws.close();
  });
});
