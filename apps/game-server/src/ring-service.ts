// =============================================================================
// RingService — server-authoritative orchestration for the Elimination Ring.
// =============================================================================
// The turn-based, N-player counterpart to GameService. Transport-agnostic on
// purpose: a connection is just an id + a `send` callback, so this is fully unit-
// testable without sockets, and the `ws` server (server.ts) is a thin shell over
// it. All authority lives in @sms/game-engine's `Ring`; this layer maps the wire
// protocol to it, broadcasts the engine's REDACTED, per-viewer views (never a
// secret, and the §4 inherited history only to the player who earned it), and
// owns the wall-clock concerns the pure core deliberately doesn't: the per-turn
// timeout (graduated skip → forfeit), the 15s-remaining turn warning, disconnect-
// forfeit grace, and guess rate-limiting.
//
// Live ring state is kept in a process-local map (acceptable for the standalone
// step-2 transport, spec §9). The SMS-integrated, Postgres-persisted equivalent
// is apps/api/src/game/ring.service.ts (step 3+); both drive the same `Ring`.
// =============================================================================

import { randomUUID } from "node:crypto";
import { Ring, RingError, type RingStatus } from "@sms/game-engine";
import type { RingClientMessage, RingServerMessage } from "./ring-protocol";

export type RingSend = (msg: RingServerMessage) => void;

interface Connection {
  id: string;
  send: RingSend;
  ringId: string | null;
  playerId: string | null;
  lastActionAt: number;
}

export interface RingServiceOptions {
  /** Per-turn time limit before a miss (ms). Default 60s (spec §4). */
  turnMs?: number;
  /** How long before the turn deadline to emit a `turn_warning` (ms). Default 15s
   *  (spec §4: "a warning at 15 seconds remaining"). No-op if >= turnMs. */
  turnWarningMs?: number;
  /** Grace after a disconnect before the absent player forfeits (ms). Default 2m. */
  disconnectGraceMs?: number;
  /** Minimum gap between a connection's gameplay actions (ms). Anti-abuse §9. */
  minActionIntervalMs?: number;
  /** Ring size bounds + graduated-timeout threshold, forwarded to the engine. */
  minPlayers?: number;
  maxPlayers?: number;
  maxConsecutiveMisses?: number;
}

export class RingService {
  private readonly turnMs: number;
  private readonly turnWarningMs: number;
  private readonly disconnectGraceMs: number;
  private readonly minActionIntervalMs: number;
  private readonly minPlayers?: number;
  private readonly maxPlayers?: number;
  private readonly maxConsecutiveMisses?: number;

  private readonly rings = new Map<string, Ring>();
  private readonly connections = new Map<string, Connection>();
  private readonly ringConnections = new Map<string, Set<string>>();
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly turnWarnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: RingServiceOptions = {}) {
    this.turnMs = opts.turnMs ?? 60_000;
    this.turnWarningMs = opts.turnWarningMs ?? 15_000;
    this.disconnectGraceMs = opts.disconnectGraceMs ?? 120_000;
    this.minActionIntervalMs = opts.minActionIntervalMs ?? 250;
    this.minPlayers = opts.minPlayers;
    this.maxPlayers = opts.maxPlayers;
    this.maxConsecutiveMisses = opts.maxConsecutiveMisses;
  }

  /** Register a new connection. Returns its server-assigned connection id. */
  connect(send: RingSend): string {
    const id = randomUUID();
    this.connections.set(id, { id, send, ringId: null, playerId: null, lastActionAt: 0 });
    return id;
  }

  /** Dispatch one raw client frame. Never throws; protocol/game errors become
   *  `error` frames back to the sender. */
  handle(connId: string, raw: string): void {
    const conn = this.connections.get(connId);
    if (!conn) return;

    let msg: RingClientMessage;
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
        case "start":
          return this.onStart(conn);
        case "secret":
          return this.onSecret(conn, msg);
        case "guess":
          return this.onGuess(conn, msg);
        case "forfeit":
          return this.onForfeit(conn);
      }
    } catch (err) {
      const code = err instanceof RingError ? err.code : "INTERNAL";
      conn.send({ type: "error", code, message: errMessage(err) });
    }
  }

  /** A connection dropped. Mark the player disconnected and arm a forfeit timer. */
  disconnect(connId: string): void {
    const conn = this.connections.get(connId);
    if (!conn) return;
    this.connections.delete(connId);
    const { ringId, playerId } = conn;
    if (ringId) this.ringConnections.get(ringId)?.delete(connId);
    if (!ringId || !playerId) return;

    const ring = this.rings.get(ringId);
    if (!ring || ring.status !== "active") return;
    try {
      ring.setConnected(playerId, false);
    } catch {
      return; // not a live player
    }
    this.broadcastState(ringId);
    // SECURITY: a hard disconnect on a live ring forfeits the absent player after a
    // grace window so they can't freeze the ring by leaving (spec §4 / §9).
    const timer = setTimeout(() => {
      const r = this.rings.get(ringId);
      if (r && r.status === "active") {
        try {
          r.forfeit(playerId);
        } catch {
          // already eliminated / resolved; nothing to do
        }
        // re-widen the status TS narrowed to "active": forfeit() may have ended it.
        if ((r.status as RingStatus) === "finished") this.finishUp(ringId);
        else {
          this.broadcastState(ringId);
          this.refreshTurnTimer(ringId);
        }
      }
    }, this.disconnectGraceMs);
    this.disconnectTimers.set(connId, timer);
  }

  /** Stop all timers (for clean shutdown / tests). */
  shutdown(): void {
    for (const t of this.turnTimers.values()) clearTimeout(t);
    for (const t of this.turnWarnTimers.values()) clearTimeout(t);
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    this.turnTimers.clear();
    this.turnWarnTimers.clear();
    this.disconnectTimers.clear();
  }

  // --- handlers -----------------------------------------------------------
  private onCreate(conn: Connection, msg: Extract<RingClientMessage, { type: "create" }>): void {
    if (conn.ringId) throw new RingError("ALREADY_IN_RING", "this connection is already in a ring");
    const displayName = requireName(msg.displayName);
    const ringId = randomUUID();
    // Ring() validates difficultyLength (throws BAD_LENGTH on a 4/5/6 violation).
    const ring = new Ring({
      id: ringId,
      difficultyLength: msg.difficultyLength ?? 4,
      ...(this.minPlayers !== undefined ? { minPlayers: this.minPlayers } : {}),
      ...(this.maxPlayers !== undefined ? { maxPlayers: this.maxPlayers } : {}),
      ...(this.maxConsecutiveMisses !== undefined
        ? { maxConsecutiveMisses: this.maxConsecutiveMisses }
        : {}),
    });
    const playerId = randomUUID();
    ring.join(playerId, displayName);
    this.rings.set(ringId, ring);
    this.bind(conn, ringId, playerId);
    conn.send({ type: "joined", ringId, playerId });
    this.broadcastState(ringId);
  }

  private onJoin(conn: Connection, msg: Extract<RingClientMessage, { type: "join" }>): void {
    if (conn.ringId) throw new RingError("ALREADY_IN_RING", "this connection is already in a ring");
    const displayName = requireName(msg.displayName);
    const ring = this.rings.get(requireString(msg.ringId, "ringId"));
    if (!ring) throw new RingError("RING_NOT_FOUND", "no such ring");
    const playerId = randomUUID();
    ring.join(playerId, displayName);
    this.bind(conn, ring.id, playerId);
    conn.send({ type: "joined", ringId: ring.id, playerId });
    this.broadcastState(ring.id);
  }

  private onStart(conn: Connection): void {
    const { ring, playerId } = this.requireSeat(conn);
    // Creator = first player to join (head of the ordered ring). Only they start.
    const creatorId = ring.viewFor().players[0]?.id;
    if (creatorId !== playerId) throw new RingError("NOT_CREATOR", "only the creator can start the ring");
    ring.start();
    this.broadcastState(ring.id);
  }

  private onSecret(conn: Connection, msg: Extract<RingClientMessage, { type: "secret" }>): void {
    const { ring, playerId } = this.requireSeat(conn);
    ring.submitSecret(playerId, requireString(msg.value, "value"));
    this.broadcastState(ring.id);
    this.refreshTurnTimer(ring.id); // started the clock if this activated the ring
  }

  private onGuess(conn: Connection, msg: Extract<RingClientMessage, { type: "guess" }>): void {
    this.rateLimit(conn);
    const { ring, playerId } = this.requireSeat(conn);
    const result = ring.guess(playerId, requireString(msg.value, "value"));
    conn.send({ type: "scored", result });
    if (ring.status === "finished") {
      this.finishUp(ring.id);
    } else {
      this.broadcastState(ring.id);
      this.refreshTurnTimer(ring.id);
    }
  }

  private onForfeit(conn: Connection): void {
    const { ring, playerId } = this.requireSeat(conn);
    ring.forfeit(playerId);
    if (ring.status === "finished") {
      this.finishUp(ring.id);
    } else {
      this.broadcastState(ring.id);
      this.refreshTurnTimer(ring.id);
    }
  }

  // --- timers -------------------------------------------------------------
  private refreshTurnTimer(ringId: string): void {
    this.clearTurnTimers(ringId);

    const ring = this.rings.get(ringId);
    if (!ring || ring.status !== "active") return;
    const timer = setTimeout(() => this.onTurnTimeout(ringId), this.turnMs);
    this.turnTimers.set(ringId, timer);

    if (this.turnWarningMs > 0 && this.turnWarningMs < this.turnMs) {
      const warn = setTimeout(() => this.onTurnWarning(ringId), this.turnMs - this.turnWarningMs);
      this.turnWarnTimers.set(ringId, warn);
    }
  }

  private clearTurnTimers(ringId: string): void {
    const turn = this.turnTimers.get(ringId);
    if (turn) clearTimeout(turn);
    this.turnTimers.delete(ringId);
    const warn = this.turnWarnTimers.get(ringId);
    if (warn) clearTimeout(warn);
    this.turnWarnTimers.delete(ringId);
  }

  private onTurnWarning(ringId: string): void {
    this.turnWarnTimers.delete(ringId);
    const ring = this.rings.get(ringId);
    if (!ring || ring.status !== "active" || !ring.currentTurnPlayerId) return;
    this.broadcast(ringId, {
      type: "turn_warning",
      playerId: ring.currentTurnPlayerId,
      remainingMs: this.turnWarningMs,
    });
  }

  private onTurnTimeout(ringId: string): void {
    const ring = this.rings.get(ringId);
    if (!ring || ring.status !== "active") return;
    try {
      ring.timeoutTurn();
    } catch {
      return;
    }
    // timeoutTurn() may have ended the ring; re-widen the narrowed "active".
    if ((ring.status as RingStatus) === "finished") this.finishUp(ringId);
    else {
      this.broadcastState(ringId);
      this.refreshTurnTimer(ringId);
    }
  }

  // --- broadcast helpers --------------------------------------------------
  private finishUp(ringId: string): void {
    this.clearTurnTimers(ringId);

    const ring = this.rings.get(ringId);
    if (!ring) return;
    this.broadcastState(ringId); // final state (secrets already cleared by the engine)
    if (ring.status === "finished" && ring.winnerId) {
      this.broadcast(ringId, { type: "over", winnerId: ring.winnerId, results: ring.results() });
    }
  }

  private broadcastState(ringId: string): void {
    const ring = this.rings.get(ringId);
    if (!ring) return;
    for (const connId of this.ringConnections.get(ringId) ?? []) {
      const conn = this.connections.get(connId);
      if (conn) conn.send({ type: "state", ring: ring.viewFor(conn.playerId) });
    }
  }

  private broadcast(ringId: string, msg: RingServerMessage): void {
    for (const connId of this.ringConnections.get(ringId) ?? []) {
      this.connections.get(connId)?.send(msg);
    }
  }

  // --- small guards -------------------------------------------------------
  private bind(conn: Connection, ringId: string, playerId: string): void {
    conn.ringId = ringId;
    conn.playerId = playerId;
    let set = this.ringConnections.get(ringId);
    if (!set) {
      set = new Set();
      this.ringConnections.set(ringId, set);
    }
    set.add(conn.id);
  }

  private requireSeat(conn: Connection): { ring: Ring; playerId: string } {
    if (!conn.ringId || !conn.playerId) throw new RingError("NO_SEAT", "join a ring first");
    const ring = this.rings.get(conn.ringId);
    if (!ring) throw new RingError("RING_NOT_FOUND", "ring no longer exists");
    return { ring, playerId: conn.playerId };
  }

  private rateLimit(conn: Connection): void {
    const now = Date.now();
    if (now - conn.lastActionAt < this.minActionIntervalMs) {
      throw new RingError("RATE_LIMITED", "slow down");
    }
    conn.lastActionAt = now;
  }

  private parse(raw: string): RingClientMessage {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || !("type" in data)) {
      throw new Error("message must be an object with a type");
    }
    const type = (data as { type: unknown }).type;
    if (
      type !== "create" &&
      type !== "join" &&
      type !== "start" &&
      type !== "secret" &&
      type !== "guess" &&
      type !== "forfeit"
    ) {
      throw new Error(`unknown message type: ${String(type)}`);
    }
    // reason: the field-level shape is checked per-handler (requireString /
    // requireName / engine validation); this narrows only the discriminant.
    return data as RingClientMessage;
  }
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string") throw new RingError("BAD_FIELD", `${field} must be a string`);
  return v;
}

function requireName(v: unknown): string {
  const s = requireString(v, "displayName").trim();
  if (s.length === 0 || s.length > 40) {
    throw new RingError("BAD_FIELD", "displayName must be 1-40 characters");
  }
  return s;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
