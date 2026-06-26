// =============================================================================
// GameSocketGateway — live game WebSockets hosted inside the SMS API (spec §11
// step 3: the real-time half of SMS integration).
// =============================================================================
// Attaches a `ws` server to the SAME http.Server Nest already listens on, via the
// `noServer` upgrade pattern so it claims ONLY `/ws/*` upgrades and leaves all
// other traffic to Express. Every handshake is authenticated against the shared
// Auth.js HS256 secret (the same token the HTTP API verifies) — an unauthenticated
// socket is closed 4401 before it reaches any service. Routing by path:
//   /ws/duel  → GameService   /ws/ring → RingService
//   /ws/race  → RaceService   /ws/arena → ArenaService
// The transport SERVICES are the shared @sms/game-transport core (also driven by
// the standalone apps/game-server); this gateway is the thin SMS-hosted shell.
//
// Live game state is in-memory per the §10 model (transient: sockets, timers, the
// current match). Durable results persistence (GameResult/Standing) is a separate,
// later slice — this gateway owns only the live session.
// =============================================================================

import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { InMemoryGameStore } from "@sms/game-engine";
import {
  ArenaService,
  AuthError,
  GameService,
  RaceService,
  RingService,
  verifyJwt,
  type GamePrincipal,
} from "@sms/game-transport";

@Injectable()
export class GameSocketGateway implements OnApplicationShutdown {
  private readonly logger = new Logger(GameSocketGateway.name);

  // One process-local instance per mode (the shared transport-agnostic core).
  private readonly duel = new GameService({ store: new InMemoryGameStore() });
  private readonly ring = new RingService();
  private readonly race = new RaceService();
  private readonly arena = new ArenaService();

  private wss?: WebSocketServer;

  /** Attach to the running http server. Call once, after `app.listen()`. */
  attach(server: HttpServer): void {
    if (this.wss) return;
    const secret = process.env.AUTH_SECRET;
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = pathOf(request.url);
      // Claim only our namespace; other upgrades are left for other handlers.
      if (!path.startsWith("/ws/")) return;
      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.wss!.emit("connection", ws, request);
      });
    });

    this.wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
      const send = (msg: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      const url = new URL(request.url ?? "/", "http://localhost");
      const mode = pathOf(request.url).slice("/ws/".length);

      // SECURITY: identity comes ONLY from the verified token; tenant isolation and
      // display identity are enforced by the transport services from this principal.
      let principal: GamePrincipal;
      try {
        if (!secret) throw new AuthError("auth is not configured");
        principal = verifyJwt(url.searchParams.get("token") ?? "", secret);
      } catch (err) {
        send({ type: "error", code: "UNAUTHORIZED", message: err instanceof AuthError ? err.message : "unauthorized" });
        socket.close(4401, "unauthorized");
        return;
      }

      switch (mode) {
        case "duel":
          return this.wire(socket, this.duel.connect(send, principal), this.duel);
        case "ring":
          return this.wire(socket, this.ring.connect(send), this.ring);
        case "race":
          return this.wire(socket, this.race.connect(send), this.race);
        case "arena":
          return this.wire(socket, this.arena.connect(send), this.arena);
        default:
          send({ type: "error", code: "NOT_FOUND", message: "unknown game mode" });
          socket.close(4404, "not found");
      }
    });

    this.logger.log("Game socket gateway attached at /ws/{duel,ring,race,arena}.");
  }

  /** Wire a socket's lifecycle to the connection id its service assigned. */
  private wire(
    socket: WebSocket,
    connId: string,
    svc: { handle: (id: string, raw: string) => void; disconnect: (id: string) => void },
  ): void {
    socket.on("message", (data: Buffer) => svc.handle(connId, data.toString()));
    socket.on("close", () => svc.disconnect(connId));
    socket.on("error", () => svc.disconnect(connId));
  }

  onApplicationShutdown(): void {
    this.duel.shutdown();
    this.ring.shutdown();
    this.race.shutdown();
    this.arena.shutdown();
    this.wss?.close();
  }
}

/** Normalize a request URL to its bare path (no query, no trailing slash). */
function pathOf(rawUrl: string | undefined): string {
  return new URL(rawUrl ?? "/", "http://localhost").pathname.replace(/\/+$/, "");
}
