// =============================================================================
// GameService — server-authoritative orchestration for the 2-player game.
// =============================================================================
// Transport-agnostic on purpose: a connection is just an id + a `send` callback,
// so this is fully unit-testable without sockets, and the `ws` server (server.ts)
// is a thin shell over it. All authority lives in @sms/game-engine's Duel; this
// layer maps the wire protocol to it, broadcasts the engine's REDACTED views
// (never a secret — spec §9), and owns the wall-clock concerns the pure core
// deliberately doesn't: turn timeouts, disconnect-forfeit, and guess rate-limit.
// =============================================================================

import { randomUUID } from "node:crypto";
import { Duel, DuelError, type DuelStatus, type GameStore } from "@sms/game-engine";
import type { ClientMessage, ServerMessage } from "./protocol";

export type Send = (msg: ServerMessage) => void;

interface Connection {
  id: string;
  send: Send;
  gameId: string | null;
  playerId: string | null;
  lastActionAt: number;
}

export interface GameServiceOptions {
  store: GameStore;
  /** Per-turn time limit before a miss (ms). Default 60s (spec §4 rationale). */
  turnMs?: number;
  /** Grace after a disconnect before the absent player forfeits (ms). Default 2m. */
  disconnectGraceMs?: number;
  /** Minimum gap between a connection's gameplay actions (ms). Anti-abuse §9. */
  minActionIntervalMs?: number;
}

export class GameService {
  private readonly store: GameStore;
  private readonly turnMs: number;
  private readonly disconnectGraceMs: number;
  private readonly minActionIntervalMs: number;

  private readonly connections = new Map<string, Connection>();
  private readonly gameConnections = new Map<string, Set<string>>();
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: GameServiceOptions) {
    this.store = opts.store;
    this.turnMs = opts.turnMs ?? 60_000;
    this.disconnectGraceMs = opts.disconnectGraceMs ?? 120_000;
    this.minActionIntervalMs = opts.minActionIntervalMs ?? 250;
  }

  /** Register a new connection. Returns its server-assigned connection id. */
  connect(send: Send): string {
    const id = randomUUID();
    this.connections.set(id, { id, send, gameId: null, playerId: null, lastActionAt: 0 });
    return id;
  }

  /** Dispatch one raw client frame. Never throws; protocol/game errors become
   *  `error` frames back to the sender. */
  handle(connId: string, raw: string): void {
    const conn = this.connections.get(connId);
    if (!conn) return;

    let msg: ClientMessage;
    try {
      msg = this.parse(raw);
    } catch (err) {
      return conn.send({ type: "error", code: "BAD_MESSAGE", message: errMessage(err) });
    }

    try {
      switch (msg.type) {
        case "create":
          return this.onCreate(conn, msg);
        case "join":
          return this.onJoin(conn, msg);
        case "secret":
          return this.onSecret(conn, msg);
        case "guess":
          return this.onGuess(conn, msg);
        case "forfeit":
          return this.onForfeit(conn);
      }
    } catch (err) {
      const code = err instanceof DuelError ? err.code : "INTERNAL";
      conn.send({ type: "error", code, message: errMessage(err) });
    }
  }

  /** A connection dropped. Mark the player disconnected and arm a forfeit timer. */
  disconnect(connId: string): void {
    const conn = this.connections.get(connId);
    if (!conn) return;
    this.connections.delete(connId);
    const { gameId, playerId } = conn;
    if (gameId) this.gameConnections.get(gameId)?.delete(connId);
    if (!gameId || !playerId) return;

    const duel = this.store.get(gameId);
    if (!duel || duel.status !== "active") return;
    duel.setConnected(playerId, false);
    this.broadcastState(gameId);
    // SECURITY: a hard disconnect on a live game forfeits after a grace window so
    // a player can't freeze the match by leaving (spec §9 disconnect handling).
    const timer = setTimeout(() => {
      const g = this.store.get(gameId);
      if (g && g.status === "active") {
        try {
          g.forfeit(playerId);
        } catch {
          // already resolved; nothing to do
        }
        this.finishUp(gameId);
      }
    }, this.disconnectGraceMs);
    this.disconnectTimers.set(connId, timer);
  }

  /** Stop all timers (for clean shutdown / tests). */
  shutdown(): void {
    for (const t of this.turnTimers.values()) clearTimeout(t);
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    this.turnTimers.clear();
    this.disconnectTimers.clear();
  }

  // --- handlers -----------------------------------------------------------
  private onCreate(conn: Connection, msg: Extract<ClientMessage, { type: "create" }>): void {
    if (conn.gameId) throw new DuelError("ALREADY_IN_GAME", "this connection is already in a game");
    const displayName = requireName(msg.displayName);
    const gameId = randomUUID();
    // Duel() validates difficultyLength (throws BAD_LENGTH on 4/5/6 violation).
    const duel = new Duel({ id: gameId, difficultyLength: msg.difficultyLength });
    const playerId = randomUUID();
    duel.join(playerId, displayName);
    this.store.save(duel);
    this.bind(conn, gameId, playerId);
    conn.send({ type: "joined", gameId, playerId });
    this.broadcastState(gameId);
  }

  private onJoin(conn: Connection, msg: Extract<ClientMessage, { type: "join" }>): void {
    if (conn.gameId) throw new DuelError("ALREADY_IN_GAME", "this connection is already in a game");
    const displayName = requireName(msg.displayName);
    const duel = this.store.get(requireString(msg.gameId, "gameId"));
    if (!duel) throw new DuelError("GAME_NOT_FOUND", "no such game");
    const playerId = randomUUID();
    duel.join(playerId, displayName);
    this.bind(conn, duel.id, playerId);
    conn.send({ type: "joined", gameId: duel.id, playerId });
    this.broadcastState(duel.id);
    this.refreshTurnTimer(duel.id);
  }

  private onSecret(conn: Connection, msg: Extract<ClientMessage, { type: "secret" }>): void {
    const { duel, playerId } = this.requireSeat(conn);
    duel.submitSecret(playerId, requireString(msg.value, "value"));
    this.broadcastState(duel.id);
    this.refreshTurnTimer(duel.id);
  }

  private onGuess(conn: Connection, msg: Extract<ClientMessage, { type: "guess" }>): void {
    this.rateLimit(conn);
    const { duel, playerId } = this.requireSeat(conn);
    const result = duel.guess(playerId, requireString(msg.value, "value"));
    conn.send({ type: "scored", result });
    if (duel.status === "finished") {
      this.finishUp(duel.id);
    } else {
      this.broadcastState(duel.id);
      this.refreshTurnTimer(duel.id);
    }
  }

  private onForfeit(conn: Connection): void {
    const { duel, playerId } = this.requireSeat(conn);
    duel.forfeit(playerId);
    this.finishUp(duel.id);
  }

  // --- timers -------------------------------------------------------------
  private refreshTurnTimer(gameId: string): void {
    const existing = this.turnTimers.get(gameId);
    if (existing) clearTimeout(existing);
    this.turnTimers.delete(gameId);

    const duel = this.store.get(gameId);
    if (!duel || duel.status !== "active") return;
    const timer = setTimeout(() => this.onTurnTimeout(gameId), this.turnMs);
    this.turnTimers.set(gameId, timer);
  }

  private onTurnTimeout(gameId: string): void {
    const duel = this.store.get(gameId);
    if (!duel || duel.status !== "active") return;
    try {
      duel.timeoutTurn();
    } catch {
      return;
    }
    // timeoutTurn() may have ended the game; re-widen the status TS narrowed to
    // "active" above (it can't see the mutating method change the field).
    if ((duel.status as DuelStatus) === "finished") this.finishUp(gameId);
    else {
      this.broadcastState(gameId);
      this.refreshTurnTimer(gameId);
    }
  }

  // --- broadcast helpers --------------------------------------------------
  private finishUp(gameId: string): void {
    const timer = this.turnTimers.get(gameId);
    if (timer) clearTimeout(timer);
    this.turnTimers.delete(gameId);

    const duel = this.store.get(gameId);
    if (!duel) return;
    this.broadcastState(gameId); // final state reveals both secrets (game over)
    if (duel.status === "finished" && duel.winnerId) {
      this.broadcast(gameId, { type: "over", winnerId: duel.winnerId, results: duel.results() });
    }
  }

  private broadcastState(gameId: string): void {
    const duel = this.store.get(gameId);
    if (!duel) return;
    for (const connId of this.gameConnections.get(gameId) ?? []) {
      const conn = this.connections.get(connId);
      if (conn) conn.send({ type: "state", game: duel.viewFor(conn.playerId) });
    }
  }

  private broadcast(gameId: string, msg: ServerMessage): void {
    for (const connId of this.gameConnections.get(gameId) ?? []) {
      this.connections.get(connId)?.send(msg);
    }
  }

  // --- small guards -------------------------------------------------------
  private bind(conn: Connection, gameId: string, playerId: string): void {
    conn.gameId = gameId;
    conn.playerId = playerId;
    let set = this.gameConnections.get(gameId);
    if (!set) {
      set = new Set();
      this.gameConnections.set(gameId, set);
    }
    set.add(conn.id);
  }

  private requireSeat(conn: Connection): { duel: Duel; playerId: string } {
    if (!conn.gameId || !conn.playerId) {
      throw new DuelError("NO_SEAT", "join a game first");
    }
    const duel = this.store.get(conn.gameId);
    if (!duel) throw new DuelError("GAME_NOT_FOUND", "game no longer exists");
    return { duel, playerId: conn.playerId };
  }

  private rateLimit(conn: Connection): void {
    const now = Date.now();
    if (now - conn.lastActionAt < this.minActionIntervalMs) {
      throw new DuelError("RATE_LIMITED", "slow down");
    }
    conn.lastActionAt = now;
  }

  private parse(raw: string): ClientMessage {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || !("type" in data)) {
      throw new Error("message must be an object with a type");
    }
    const type = (data as { type: unknown }).type;
    if (
      type !== "create" &&
      type !== "join" &&
      type !== "secret" &&
      type !== "guess" &&
      type !== "forfeit"
    ) {
      throw new Error(`unknown message type: ${String(type)}`);
    }
    // reason: the field-level shape is checked per-handler (requireString /
    // requireName / engine validation); this narrows only the discriminant.
    return data as ClientMessage;
  }
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string") throw new DuelError("BAD_FIELD", `${field} must be a string`);
  return v;
}

function requireName(v: unknown): string {
  const s = requireString(v, "displayName").trim();
  if (s.length === 0 || s.length > 40) {
    throw new DuelError("BAD_FIELD", "displayName must be 1-40 characters");
  }
  return s;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
