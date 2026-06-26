import { createHmac } from "node:crypto";
import { WebSocket } from "ws";
import { generateSecret } from "@sms/game-engine";
import { createGameServer, type RunningGameServer } from "./server";
import type { ClientMessage, ServerMessage } from "./protocol";
import type { RingClientMessage, RingServerMessage } from "./ring-protocol";
import type { RaceClientMessage, RaceServerMessage } from "./race-protocol";
import type { ArenaClientMessage, ArenaServerMessage } from "./arena-protocol";

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

/** A real WebSocket client for the `/ring` path with a typed `wait(...)` helper. */
function connectRingClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ring`);
  const received: RingServerMessage[] = [];
  const waiters: Array<{ pred: (m: RingServerMessage) => boolean; resolve: (m: RingServerMessage) => void }> =
    [];

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as RingServerMessage;
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
    send: (m: RingClientMessage) => ws.send(JSON.stringify(m)),
    wait<T extends RingServerMessage["type"]>(
      type: T,
      pred: (m: Extract<RingServerMessage, { type: T }>) => boolean = () => true,
    ): Promise<Extract<RingServerMessage, { type: T }>> {
      const match = (m: RingServerMessage): m is Extract<RingServerMessage, { type: T }> =>
        m.type === type && pred(m as Extract<RingServerMessage, { type: T }>);
      const existing = received.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) =>
        waiters.push({ pred: match, resolve: (m) => resolve(m as Extract<RingServerMessage, { type: T }>) }),
      );
    },
  };
}

/** A real WebSocket client for the `/race` path with a typed `wait(...)` helper. */
function connectRaceClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/race`);
  const received: RaceServerMessage[] = [];
  const waiters: Array<{ pred: (m: RaceServerMessage) => boolean; resolve: (m: RaceServerMessage) => void }> =
    [];

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as RaceServerMessage;
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
    send: (m: RaceClientMessage) => ws.send(JSON.stringify(m)),
    wait<T extends RaceServerMessage["type"]>(
      type: T,
      pred: (m: Extract<RaceServerMessage, { type: T }>) => boolean = () => true,
    ): Promise<Extract<RaceServerMessage, { type: T }>> {
      const match = (m: RaceServerMessage): m is Extract<RaceServerMessage, { type: T }> =>
        m.type === type && pred(m as Extract<RaceServerMessage, { type: T }>);
      const existing = received.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) =>
        waiters.push({ pred: match, resolve: (m) => resolve(m as Extract<RaceServerMessage, { type: T }>) }),
      );
    },
  };
}

/** A real WebSocket client for the `/arena` path with a typed `wait(...)` helper. */
function connectArenaClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/arena`);
  const received: ArenaServerMessage[] = [];
  const waiters: Array<{ pred: (m: ArenaServerMessage) => boolean; resolve: (m: ArenaServerMessage) => void }> =
    [];

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as ArenaServerMessage;
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
    send: (m: ArenaClientMessage) => ws.send(JSON.stringify(m)),
    wait<T extends ArenaServerMessage["type"]>(
      type: T,
      pred: (m: Extract<ArenaServerMessage, { type: T }>) => boolean = () => true,
    ): Promise<Extract<ArenaServerMessage, { type: T }>> {
      const match = (m: ArenaServerMessage): m is Extract<ArenaServerMessage, { type: T }> =>
        m.type === type && pred(m as Extract<ArenaServerMessage, { type: T }>);
      const existing = received.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) =>
        waiters.push({ pred: match, resolve: (m) => resolve(m as Extract<ArenaServerMessage, { type: T }>) }),
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
    server = createGameServer({ port: 0, authSecret: "" }); // open mode, ignore ambient AUTH_SECRET
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

  it("routes the /ring path to the ring transport and plays a full ring", async () => {
    server = createGameServer({ port: 0, authSecret: "" }); // open mode, ignore ambient AUTH_SECRET
    const port = server.port();
    const A = connectRingClient(port);
    const B = connectRingClient(port);
    const C = connectRingClient(port);
    await Promise.all([A.opened, B.opened, C.opened]);

    A.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    const aJoined = await A.wait("joined");
    B.send({ type: "join", ringId: aJoined.ringId, displayName: "Bob" });
    await B.wait("joined");
    C.send({ type: "join", ringId: aJoined.ringId, displayName: "Carol" });
    const cJoined = await C.wait("joined");

    A.send({ type: "start" });
    A.send({ type: "secret", value: "1234" });
    B.send({ type: "secret", value: "5678" });
    C.send({ type: "secret", value: "9012" });

    // Ring is alice→bob→carol→alice, Alice starts. Alice cracks Bob (5678).
    await A.wait("state", (m) => m.ring.status === "active" && m.ring.currentTurnPlayerId === aJoined.playerId);
    A.send({ type: "guess", value: "5678" });
    // Turn advances to Carol (Alice's re-closed target). Carol cracks Alice (1234).
    await C.wait("state", (m) => m.ring.currentTurnPlayerId === cJoined.playerId);
    C.send({ type: "guess", value: "1234" });

    const over = await C.wait("over");
    expect(over.winnerId).toBe(cJoined.playerId);

    // SECURITY: Carol's never-cracked secret (9012) appeared on no client's wire.
    for (const client of [A, B, C]) {
      for (const msg of client.received) {
        expect(JSON.stringify(msg)).not.toContain("9012");
      }
    }
    A.ws.close();
    B.ws.close();
    C.ws.close();
  });

  it("routes the /race path to the race transport and plays a full race", async () => {
    // Seed the target deterministically so the test can actually crack it.
    const target = generateSecret(4, () => 0);
    server = createGameServer({ port: 0, raceRng: () => 0, minActionIntervalMs: 0, authSecret: "" });
    const port = server.port();
    const A = connectRaceClient(port);
    const B = connectRaceClient(port);
    const C = connectRaceClient(port);
    await Promise.all([A.opened, B.opened, C.opened]);

    A.send({ type: "create", difficultyLength: 4, displayName: "Alice" });
    const aJoined = await A.wait("joined");
    B.send({ type: "join", raceId: aJoined.raceId, displayName: "Bob" });
    const bJoined = await B.wait("joined");
    C.send({ type: "join", raceId: aJoined.raceId, displayName: "Carol" });
    await C.wait("joined");

    A.send({ type: "start" });
    await A.wait("state", (m) => m.race.status === "active");

    // All three crack the shared target; with 3 finishers (== participants) it ends.
    A.send({ type: "guess", value: target });
    B.send({ type: "guess", value: target });
    C.send({ type: "guess", value: target });

    const over = await A.wait("over");
    expect(over.winnerId).toBe(aJoined.playerId);
    expect(over.results.find((r) => r.playerId === bJoined.playerId)?.rank).toBe(2);

    // SECURITY: the target never appeared in a frame that wasn't the guesser's own
    // crack — check a client that never guessed it would not have seen it; here all
    // guessed it, so assert no `target`/`secret` field was ever serialized.
    for (const client of [A, B, C]) {
      for (const msg of client.received) {
        expect(JSON.stringify(msg)).not.toMatch(/"target"|"secret"/);
      }
    }
    A.ws.close();
    B.ws.close();
    C.ws.close();
  });

  it("routes the /arena path to the arena transport (countdown → crack → over)", async () => {
    const target = generateSecret(4, () => 0);
    // Short get-ready so the real-socket test runs fast; seed the target.
    server = createGameServer({ port: 0, arenaRng: () => 0, arenaGetReadyMs: 30, minActionIntervalMs: 0, authSecret: "" });
    const port = server.port();
    const admin = connectArenaClient(port);
    const player = connectArenaClient(port);
    await Promise.all([admin.opened, player.opened]);

    admin.send({ type: "create", difficultyLength: 4 });
    const created = await admin.wait("created");
    player.send({ type: "enter", arenaId: created.arenaId, handle: "Alice" });
    await player.wait("entered");
    await player.wait("countdown");

    // After the get-ready countdown the player's race begins.
    await player.wait("state", (m) => m.arena.yourEntry?.status === "racing");
    player.send({ type: "guess", value: target });
    await player.wait("state", (m) => m.arena.yourEntry?.status === "finished");

    admin.send({ type: "close" });
    const over = await admin.wait("over");
    expect(over.results[0]).toMatchObject({ handle: "Alice", rank: 1 });

    // SECURITY: no per-entry target/secret on the wire to anyone.
    for (const client of [admin, player]) {
      for (const msg of client.received) {
        expect(JSON.stringify(msg)).not.toMatch(/"target"|"secret"/);
      }
    }
    admin.ws.close();
    player.ws.close();
  });

  it("enforces handshake auth: a valid token connects, a missing one is closed 4401", async () => {
    const secret = "shared-auth-secret";
    const sign = (payload: Record<string, unknown>) => {
      const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const s = createHmac("sha256", secret).update(`${h}.${b}`).digest("base64url");
      return `${h}.${b}.${s}`;
    };
    server = createGameServer({ port: 0, authSecret: secret });
    const port = server.port();
    const token = sign({ userId: "u1", school_id: "s1", name: "Ada", exp: Math.floor(Date.now() / 1000) + 60 });

    // Authenticated duel handshake → can create a game.
    const ok = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    const okMsgs: ServerMessage[] = [];
    ok.on("message", (d) => okMsgs.push(JSON.parse(d.toString()) as ServerMessage));
    await new Promise<void>((r) => ok.on("open", () => r()));
    ok.send(JSON.stringify({ type: "create", difficultyLength: 4 }));
    await new Promise<void>((r) => {
      const t = setInterval(() => {
        if (okMsgs.some((m) => m.type === "joined")) {
          clearInterval(t);
          r();
        }
      }, 5);
    });
    expect(okMsgs.some((m) => m.type === "joined")).toBe(true);
    ok.close();

    // No token → the socket is closed with the 4401 policy code.
    const bad = new WebSocket(`ws://127.0.0.1:${port}/`);
    const closeCode = await new Promise<number>((r) => bad.on("close", (code) => r(code)));
    expect(closeCode).toBe(4401);
  });
});
