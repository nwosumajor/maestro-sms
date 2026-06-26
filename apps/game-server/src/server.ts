// =============================================================================
// WebSocket transport shell (spec §11 steps 2 & 6; real-time per §9).
// =============================================================================
// Deliberately thin: it owns only the socket plumbing and delegates ALL game
// authority to the services / engine. One socket == one connection. Connections
// are routed by path: `/ring` drives the Elimination Ring (RingService), `/race`
// the Class Race (RaceService), `/arena` the Ultimate cross-school arena
// (ArenaService); anything else drives the 2-player duel (GameService, the default
// for back-compat). Each service assigns the player id and decides what (redacted)
// state to send back.
//
// AUTH (spec §11 step 3): when an `authSecret` is configured the handshake MUST
// carry a valid JWT (`?token=…`); an unauthenticated socket is closed with 4401
// before it is bound to any service. The verified principal is the live identity
// the duel uses (and is available to thread into the other modes). With NO secret
// the server runs in open dev mode (display-name identity), mirroring the SMS
// "gracefully disabled when the secret is unset" pattern.
// =============================================================================

import { WebSocket, WebSocketServer } from "ws";
import { InMemoryGameStore, type GameStore } from "@sms/game-engine";
import { GameService } from "./game-service";
import { RingService } from "./ring-service";
import { RaceService } from "./race-service";
import { ArenaService } from "./arena-service";
import { AuthError, verifyJwt, type GamePrincipal } from "./auth";

export interface GameServerOptions {
  /** 0 (default) binds an ephemeral port — handy for tests. */
  port?: number;
  store?: GameStore;
  turnMs?: number;
  /** Lead time for the `turn_warning` frame (ms). Shared by both modes. */
  turnWarningMs?: number;
  disconnectGraceMs?: number;
  minActionIntervalMs?: number;
  /** Ring-only engine bounds (forwarded to RingService / Ring). */
  ringMinPlayers?: number;
  ringMaxPlayers?: number;
  ringMaxConsecutiveMisses?: number;
  /** Race-only: finishers that win / end the race (forwarded to RaceService / Race). */
  raceWinners?: number;
  /** Race target RNG — inject a deterministic seed in tests ONLY (prod = CSPRNG). */
  raceRng?: () => number;
  /** Arena get-ready countdown before a player's clock starts (ms). Default 15s. */
  arenaGetReadyMs?: number;
  /** Arena target RNG — inject a deterministic seed in tests ONLY (prod = CSPRNG). */
  arenaRng?: () => number;
  /** Shared Auth.js HS256 secret. When set, the handshake MUST carry a valid
   *  `?token=`; unset ⇒ open dev mode. Defaults to `process.env.AUTH_SECRET`. */
  authSecret?: string;
}

export interface RunningGameServer {
  wss: WebSocketServer;
  service: GameService;
  ringService: RingService;
  raceService: RaceService;
  arenaService: ArenaService;
  port: () => number;
  close: () => Promise<void>;
}

export function createGameServer(opts: GameServerOptions = {}): RunningGameServer {
  const store = opts.store ?? new InMemoryGameStore();
  const service = new GameService({
    store,
    turnMs: opts.turnMs,
    turnWarningMs: opts.turnWarningMs,
    disconnectGraceMs: opts.disconnectGraceMs,
    minActionIntervalMs: opts.minActionIntervalMs,
  });
  const ringService = new RingService({
    turnMs: opts.turnMs,
    turnWarningMs: opts.turnWarningMs,
    disconnectGraceMs: opts.disconnectGraceMs,
    minActionIntervalMs: opts.minActionIntervalMs,
    minPlayers: opts.ringMinPlayers,
    maxPlayers: opts.ringMaxPlayers,
    maxConsecutiveMisses: opts.ringMaxConsecutiveMisses,
  });
  const raceService = new RaceService({
    minActionIntervalMs: opts.minActionIntervalMs,
    winners: opts.raceWinners,
    rng: opts.raceRng,
  });
  const arenaService = new ArenaService({
    minActionIntervalMs: opts.minActionIntervalMs,
    getReadyMs: opts.arenaGetReadyMs,
    rng: opts.arenaRng,
  });

  const authSecret = opts.authSecret ?? process.env.AUTH_SECRET;

  const wss = new WebSocketServer({ port: opts.port ?? 0 });
  wss.on("connection", (socket, request) => {
    // SECURITY: the only payloads sent are a service's redacted frames; the engine
    // guarantees no live secret is in them.
    const send = (msg: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    };
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "");

    // Handshake auth gate (covers ALL modes before routing). Closed sockets never
    // reach a service. // SECURITY: identity comes only from the verified token.
    let principal: GamePrincipal | undefined;
    if (authSecret) {
      const token = url.searchParams.get("token") ?? "";
      try {
        principal = verifyJwt(token, authSecret);
      } catch (err) {
        send({ type: "error", code: "UNAUTHORIZED", message: err instanceof AuthError ? err.message : "unauthorized" });
        socket.close(4401, "unauthorized");
        return;
      }
    }

    if (path === "/ring") {
      const connId = ringService.connect(send);
      socket.on("message", (data) => ringService.handle(connId, data.toString()));
      socket.on("close", () => ringService.disconnect(connId));
      socket.on("error", () => ringService.disconnect(connId));
    } else if (path === "/race") {
      const connId = raceService.connect(send);
      socket.on("message", (data) => raceService.handle(connId, data.toString()));
      socket.on("close", () => raceService.disconnect(connId));
      socket.on("error", () => raceService.disconnect(connId));
    } else if (path === "/arena") {
      const connId = arenaService.connect(send);
      socket.on("message", (data) => arenaService.handle(connId, data.toString()));
      socket.on("close", () => arenaService.disconnect(connId));
      socket.on("error", () => arenaService.disconnect(connId));
    } else {
      const connId = service.connect(send, principal);
      socket.on("message", (data) => service.handle(connId, data.toString()));
      socket.on("close", () => service.disconnect(connId));
      socket.on("error", () => service.disconnect(connId));
    }
  });

  return {
    wss,
    service,
    ringService,
    raceService,
    arenaService,
    port: () => {
      const addr = wss.address();
      return typeof addr === "object" && addr !== null ? addr.port : 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        service.shutdown();
        ringService.shutdown();
        raceService.shutdown();
        arenaService.shutdown();
        wss.close(() => resolve());
      }),
  };
}
