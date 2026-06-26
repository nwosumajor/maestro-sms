// =============================================================================
// ArenaService — server-authoritative orchestration for the Ultimate arena.
// =============================================================================
// The cross-school arena transport (spec §7). Transport-agnostic: a connection is
// just an id + a `send` callback, so this is fully unit-testable without sockets.
// All authority lives in @sms/game-engine's `Arena`; this layer maps the wire
// protocol to it and broadcasts the engine's REDACTED views (handles + scores
// only; per-entry targets are never serialized).
//
// Like the race transport it is parallel (no turns) and a disconnect does NOT
// forfeit. The wall-clock concerns it owns: per-player guess rate-limiting, and —
// unique to the arena — the spec §10 get-ready COUNTDOWN: on `enter` the player's
// clock does NOT start; the server sends a `countdown`, and only when it elapses
// does it call `arena.begin()` (starting own-start elapsed at the real race start)
// and let them guess. An ADMIN connection (the `create`r) owns the arena and may
// `close` it; admins are not players. Live arena state is a process-local map
// (step-2 in-memory); the persisted, consent-gated equivalent is the SMS service.
// =============================================================================

import { randomInt, randomUUID } from "node:crypto";
import { Arena, ArenaError } from "@sms/game-engine";
import type { ArenaClientMessage, ArenaServerMessage } from "./arena-protocol";

export type ArenaSend = (msg: ArenaServerMessage) => void;

interface Connection {
  id: string;
  send: ArenaSend;
  arenaId: string | null;
  /** Set for players; null for the admin connection that created the arena. */
  participantId: string | null;
  isAdmin: boolean;
  lastActionAt: number;
}

export interface ArenaServiceOptions {
  /** Minimum gap between a player's guesses (ms). Anti-abuse §5. Default 250. */
  minActionIntervalMs?: number;
  /** Get-ready countdown before a player's clock starts (ms). Default 15s (§10). */
  getReadyMs?: number;
  /** RNG for per-entry target generation; defaults to a CSPRNG. Inject for tests. */
  rng?: () => number;
}

/** SECURITY: a CSPRNG so generated targets aren't predictable (spec §9). */
const cryptoRng = () => randomInt(0, 1_000_000) / 1_000_000;

export class ArenaService {
  private readonly minActionIntervalMs: number;
  private readonly getReadyMs: number;
  private readonly rng: () => number;

  private readonly arenas = new Map<string, Arena>();
  private readonly connections = new Map<string, Connection>();
  private readonly arenaConnections = new Map<string, Set<string>>();
  /** participantId → get-ready timer (started on enter, fires `begin`). */
  private readonly countdownTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: ArenaServiceOptions = {}) {
    this.minActionIntervalMs = opts.minActionIntervalMs ?? 250;
    this.getReadyMs = opts.getReadyMs ?? 15_000;
    this.rng = opts.rng ?? cryptoRng;
  }

  /** Register a new connection. Returns its server-assigned connection id. */
  connect(send: ArenaSend): string {
    const id = randomUUID();
    this.connections.set(id, {
      id,
      send,
      arenaId: null,
      participantId: null,
      isAdmin: false,
      lastActionAt: 0,
    });
    return id;
  }

  /** Dispatch one raw client frame. Never throws; errors become `error` frames. */
  handle(connId: string, raw: string): void {
    const conn = this.connections.get(connId);
    if (!conn) return;

    let msg: ArenaClientMessage;
    try {
      msg = this.parse(raw);
    } catch (err) {
      return conn.send({ type: "error", code: "BAD_MESSAGE", message: errMessage(err) });
    }

    try {
      switch (msg.type) {
        case "create":
          return this.onCreate(conn, msg);
        case "enter":
          return this.onEnter(conn, msg);
        case "guess":
          return this.onGuess(conn, msg);
        case "close":
          return this.onClose(conn);
      }
    } catch (err) {
      const code = err instanceof ArenaError ? err.code : "INTERNAL";
      conn.send({ type: "error", code, message: errMessage(err) });
    }
  }

  /** A connection dropped. Parallel play, so this does NOT forfeit; just clear the
   *  connection and any pending get-ready timer. */
  disconnect(connId: string): void {
    const conn = this.connections.get(connId);
    if (!conn) return;
    this.connections.delete(connId);
    if (conn.arenaId) this.arenaConnections.get(conn.arenaId)?.delete(connId);
    if (conn.participantId) this.clearCountdown(conn.participantId);
  }

  /** Stop all get-ready timers (clean shutdown / tests). */
  shutdown(): void {
    for (const t of this.countdownTimers.values()) clearTimeout(t);
    this.countdownTimers.clear();
  }

  // --- handlers -----------------------------------------------------------
  private onCreate(conn: Connection, msg: Extract<ArenaClientMessage, { type: "create" }>): void {
    if (conn.arenaId) throw new ArenaError("ALREADY_IN_ARENA", "this connection is already in an arena");
    const arenaId = randomUUID();
    // Arena() validates difficultyLength (BAD_LENGTH).
    const arena = new Arena({ id: arenaId, difficultyLength: msg.difficultyLength ?? 4, rng: this.rng });
    this.arenas.set(arenaId, arena);
    conn.arenaId = arenaId;
    conn.isAdmin = true;
    this.bind(conn, arenaId);
    conn.send({ type: "created", arenaId });
  }

  private onEnter(conn: Connection, msg: Extract<ArenaClientMessage, { type: "enter" }>): void {
    if (conn.arenaId) throw new ArenaError("ALREADY_IN_ARENA", "this connection is already in an arena");
    const arena = this.arenas.get(requireString(msg.arenaId, "arenaId"));
    if (!arena) throw new ArenaError("ARENA_NOT_FOUND", "no such arena");
    const participantId = randomUUID();
    arena.enter(participantId, requireString(msg.handle, "handle"));
    conn.arenaId = arena.id;
    conn.participantId = participantId;
    this.bind(conn, arena.id);
    conn.send({ type: "entered", arenaId: arena.id, participantId });
    conn.send({ type: "countdown", remainingMs: this.getReadyMs });
    this.broadcastState(arena.id);
    // Start the get-ready clock; when it elapses, begin this player's race.
    const timer = setTimeout(() => this.beginRace(arena.id, participantId), this.getReadyMs);
    this.countdownTimers.set(participantId, timer);
  }

  private onGuess(conn: Connection, msg: Extract<ArenaClientMessage, { type: "guess" }>): void {
    this.rateLimit(conn);
    const { arena, participantId } = this.requirePlayer(conn);
    const result = arena.guess(participantId, requireString(msg.value, "value"));
    conn.send({ type: "scored", result });
    this.broadcastState(arena.id);
  }

  private onClose(conn: Connection): void {
    if (!conn.arenaId || !conn.isAdmin) throw new ArenaError("NOT_ADMIN", "only the arena admin can close it");
    const arena = this.arenas.get(conn.arenaId);
    if (!arena) throw new ArenaError("ARENA_NOT_FOUND", "arena no longer exists");
    arena.close();
    this.broadcastState(arena.id);
    this.broadcast(arena.id, { type: "over", results: arena.results() });
  }

  // --- get-ready countdown ------------------------------------------------
  private beginRace(arenaId: string, participantId: string): void {
    this.clearCountdown(participantId);
    const arena = this.arenas.get(arenaId);
    if (!arena) return;
    try {
      arena.begin(participantId);
    } catch {
      return; // arena closed, or already begun
    }
    this.broadcastState(arenaId);
  }

  private clearCountdown(participantId: string): void {
    const t = this.countdownTimers.get(participantId);
    if (t) clearTimeout(t);
    this.countdownTimers.delete(participantId);
  }

  // --- broadcast helpers --------------------------------------------------
  private broadcastState(arenaId: string): void {
    const arena = this.arenas.get(arenaId);
    if (!arena) return;
    for (const connId of this.arenaConnections.get(arenaId) ?? []) {
      const conn = this.connections.get(connId);
      if (conn) conn.send({ type: "state", arena: arena.viewFor(conn.participantId) });
    }
  }

  private broadcast(arenaId: string, msg: ArenaServerMessage): void {
    for (const connId of this.arenaConnections.get(arenaId) ?? []) {
      this.connections.get(connId)?.send(msg);
    }
  }

  // --- small guards -------------------------------------------------------
  private bind(conn: Connection, arenaId: string): void {
    let set = this.arenaConnections.get(arenaId);
    if (!set) {
      set = new Set();
      this.arenaConnections.set(arenaId, set);
    }
    set.add(conn.id);
  }

  private requirePlayer(conn: Connection): { arena: Arena; participantId: string } {
    if (!conn.arenaId || !conn.participantId) throw new ArenaError("NO_SEAT", "enter an arena first");
    const arena = this.arenas.get(conn.arenaId);
    if (!arena) throw new ArenaError("ARENA_NOT_FOUND", "arena no longer exists");
    return { arena, participantId: conn.participantId };
  }

  private rateLimit(conn: Connection): void {
    const now = Date.now();
    if (now - conn.lastActionAt < this.minActionIntervalMs) {
      throw new ArenaError("RATE_LIMITED", "slow down");
    }
    conn.lastActionAt = now;
  }

  private parse(raw: string): ArenaClientMessage {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || !("type" in data)) {
      throw new Error("message must be an object with a type");
    }
    const type = (data as { type: unknown }).type;
    if (type !== "create" && type !== "enter" && type !== "guess" && type !== "close") {
      throw new Error(`unknown message type: ${String(type)}`);
    }
    // reason: field-level shape is checked per-handler (requireString / engine
    // validation); this narrows only the discriminant.
    return data as ArenaClientMessage;
  }
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string") throw new ArenaError("BAD_FIELD", `${field} must be a string`);
  return v;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
