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
// /ws/watch is different: a READ-ONLY spectator of a DURABLE duel. It does NOT use
// the in-memory transport — it subscribes to GameEventsService (commits to the
// Postgres-backed GameService) and pushes the same RLS-scoped, viewer-redacted
// view the HTTP GET returns. This is the §10 live-push bridge over the durable
// authority; the durable API stays the sole source of truth.
//
// Live game state is in-memory per the §10 model (transient: sockets, timers, the
// current match). Durable results persistence (GameResult/Standing) is a separate,
// later slice — this gateway owns only the live session.
// =============================================================================

import { Injectable, Logger, NotFoundException, type OnApplicationShutdown } from "@nestjs/common";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { InMemoryGameStore } from "@sms/game-engine";
import { GAME_PERMISSIONS } from "@sms/types";
import {
  ArenaService,
  AuthError,
  GameService,
  RaceService,
  RingService,
  verifyJwt,
  type GamePrincipal,
} from "@sms/game-transport";
import type { Principal } from "../integrity/integrity.foundation";
import { GameService as DurableGameService } from "../game/game.service";
import { RingService as DurableRingService } from "../game/ring.service";
import { RaceService as DurableRaceService } from "../game/race.service";
import { CompetitionService as DurableCompetitionService } from "../game/competition.service";
import { UltimateService } from "../game/ultimate.service";
import { GameEventsService } from "../game/game-events.service";

@Injectable()
export class GameSocketGateway implements OnApplicationShutdown {
  private readonly logger = new Logger(GameSocketGateway.name);

  // The durable, RLS-scoped game cores + their shared "game changed" pub/sub. The
  // /ws/watch path subscribes to changes and re-reads the viewer-redacted view
  // through these — so live pushes carry exactly what the HTTP GET would, never
  // more. One mode per durable getter; all share the single GameEventsService bus
  // (keyed by gameId, which is unique across modes).
  constructor(
    private readonly durableGames: DurableGameService,
    private readonly durableRings: DurableRingService,
    private readonly durableRaces: DurableRaceService,
    private readonly durableCompetitions: DurableCompetitionService,
    private readonly durableUltimate: UltimateService,
    private readonly events: GameEventsService,
  ) {}

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
        case "watch":
          return this.watch(
            socket,
            send,
            principal,
            url.searchParams.get("gameId"),
            url.searchParams.get("mode"),
          );
        default:
          send({ type: "error", code: "NOT_FOUND", message: "unknown game mode" });
          socket.close(4404, "not found");
      }
    });

    this.logger.log("Game socket gateway attached at /ws/{duel,ring,race,arena,watch}.");
  }

  /**
   * Live spectator of a DURABLE game (the §10 push bridge), across the three
   * turn/parallel modes that have a single durable game id: `duel`, `ring`,
   * `race` (the `mode` query param; default `duel`). Read-only: the socket never
   * mutates — the HTTP API stays the sole authority. On every committed change to
   * `gameId`, re-reads the RLS-scoped, viewer-redacted view via the matching
   * durable service and pushes it, so the wire carries exactly what the mode's
   * `GET` returns — no secrets, no cross-tenant rows, same per-viewer redaction.
   *
   * SECURITY: three checks, same as each HTTP path — the mode's coarse permission
   * (from the verified token), relationship scope + RLS inside the getter (a
   * non-participant or cross-tenant id reads back as 404, never 403), and the
   * token-derived identity (never the query).
   */
  private watch(
    socket: WebSocket,
    send: (msg: unknown) => void,
    principal: GamePrincipal,
    gameId: string | null,
    mode: string | null,
  ): void {
    // Per-mode: the coarse permission the HTTP GET enforces + its viewer-redacted
    // reader. duel/ring gate on game.play; race/league/ultimate views gate on
    // game.leaderboard.read. `league`/`ultimate` ids are competition ids, not game
    // ids; `ultimate` reads the CROSS-SCHOOL leaderboard — pseudonymous handles +
    // school names + scores only, no PII (the leaderboard DTO is the boundary).
    const readers: Record<
      string,
      { permission: string; read: (p: Principal, id: string) => Promise<unknown> }
    > = {
      duel: { permission: GAME_PERMISSIONS.PLAY, read: (p, id) => this.durableGames.getGame(p, id) },
      ring: { permission: GAME_PERMISSIONS.PLAY, read: (p, id) => this.durableRings.getRing(p, id) },
      race: { permission: GAME_PERMISSIONS.LEADERBOARD_READ, read: (p, id) => this.durableRaces.getRace(p, id) },
      league: { permission: GAME_PERMISSIONS.LEADERBOARD_READ, read: (p, id) => this.durableCompetitions.get(p, id) },
      ultimate: { permission: GAME_PERMISSIONS.LEADERBOARD_READ, read: (p, id) => this.durableUltimate.leaderboard(p, id) },
    };
    const reader = readers[mode ?? "duel"];
    if (!reader) {
      send({ type: "error", code: "BAD_REQUEST", message: "unknown watch mode" });
      socket.close(4400, "bad request");
      return;
    }
    if (!principal.permissions.includes(reader.permission)) {
      send({ type: "error", code: "FORBIDDEN", message: `missing ${reader.permission}` });
      socket.close(4403, "forbidden");
      return;
    }
    if (!gameId) {
      send({ type: "error", code: "BAD_REQUEST", message: "gameId is required" });
      socket.close(4400, "bad request");
      return;
    }

    // The durable services want the full Principal shape; project it from the
    // token. permissions/roles ride along but the getter's guard is the seat + RLS.
    const p: Principal = {
      schoolId: principal.schoolId,
      userId: principal.userId,
      roles: principal.roles,
      permissions: principal.permissions,
    };

    let closed = false;
    const pushView = async (): Promise<void> => {
      if (closed) return;
      try {
        const game = await reader.read(p, gameId);
        send({ type: "state", game });
      } catch (err) {
        // 404 = not a participant / cross-tenant / gone. Don't leak which.
        if (err instanceof NotFoundException) {
          send({ type: "error", code: "NOT_FOUND", message: "game not found" });
        } else {
          this.logger.warn(`watch push failed for ${gameId}: ${String(err)}`);
          send({ type: "error", code: "INTERNAL", message: "view unavailable" });
        }
        closed = true;
        socket.close(4404, "not found");
      }
    };

    // Subscribe to commits, filtered to this game; nudges trigger a fresh re-read.
    const unsubscribe = this.events.onChanged((changedId) => {
      if (changedId === gameId) void pushView();
    });
    const teardown = () => {
      closed = true;
      unsubscribe();
    };
    socket.on("close", teardown);
    socket.on("error", teardown);

    // Push the current state immediately so a late joiner is in sync at once.
    void pushView();
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
