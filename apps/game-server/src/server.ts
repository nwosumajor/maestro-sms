// =============================================================================
// WebSocket transport shell (spec §11 step 2; real-time per §9).
// =============================================================================
// Deliberately thin: it owns only the socket plumbing and delegates ALL game
// authority to GameService / the engine. One socket == one connection; the
// service assigns the player id and decides what (redacted) state to send back.
// =============================================================================

import { WebSocket, WebSocketServer } from "ws";
import { InMemoryGameStore, type GameStore } from "@sms/game-engine";
import { GameService } from "./game-service";

export interface GameServerOptions {
  /** 0 (default) binds an ephemeral port — handy for tests. */
  port?: number;
  store?: GameStore;
  turnMs?: number;
  disconnectGraceMs?: number;
  minActionIntervalMs?: number;
}

export interface RunningGameServer {
  wss: WebSocketServer;
  service: GameService;
  port: () => number;
  close: () => Promise<void>;
}

export function createGameServer(opts: GameServerOptions = {}): RunningGameServer {
  const store = opts.store ?? new InMemoryGameStore();
  const service = new GameService({
    store,
    turnMs: opts.turnMs,
    disconnectGraceMs: opts.disconnectGraceMs,
    minActionIntervalMs: opts.minActionIntervalMs,
  });

  const wss = new WebSocketServer({ port: opts.port ?? 0 });
  wss.on("connection", (socket) => {
    const connId = service.connect((msg) => {
      // SECURITY: the only payloads sent are GameService's redacted frames; the
      // engine guarantees no live secret is in them.
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    });
    socket.on("message", (data) => service.handle(connId, data.toString()));
    socket.on("close", () => service.disconnect(connId));
    socket.on("error", () => service.disconnect(connId));
  });

  return {
    wss,
    service,
    port: () => {
      const addr = wss.address();
      return typeof addr === "object" && addr !== null ? addr.port : 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        service.shutdown();
        wss.close(() => resolve());
      }),
  };
}
