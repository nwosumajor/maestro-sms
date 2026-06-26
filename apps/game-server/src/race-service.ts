// =============================================================================
// RaceService — server-authoritative orchestration for the Class Race.
// =============================================================================
// The parallel (turn-less) counterpart to GameService / RingService. Transport-
// agnostic: a connection is just an id + a `send` callback, so this is fully unit-
// testable without sockets, and the `ws` server (server.ts) is a thin shell over
// it. All authority lives in @sms/game-engine's `Race`; this layer maps the wire
// protocol to it and broadcasts the engine's REDACTED, per-viewer views (the
// shared target is never serialized; a racer sees only their own guesses).
//
// Because a race is parallel, this transport is simpler than the ring's: there are
// NO turn timers / warnings, and a disconnect does NOT forfeit (others keep racing
// and a racer may reconnect). The one wall-clock concern it owns is per-racer
// guess rate-limiting (anti-abuse, spec §5). Live race state is a process-local
// map (step-2 in-memory); the Postgres-persisted equivalent is
// apps/api/src/game/race.service.ts (step 3+).
// =============================================================================

import { randomInt, randomUUID } from "node:crypto";
import { Race, RaceError } from "@sms/game-engine";
import type { RaceClientMessage, RaceServerMessage } from "./race-protocol";

export type RaceSend = (msg: RaceServerMessage) => void;

interface Connection {
  id: string;
  send: RaceSend;
  raceId: string | null;
  playerId: string | null;
  lastActionAt: number;
}

export interface RaceServiceOptions {
  /** Minimum gap between a racer's guesses (ms). Anti-abuse §5. Default 250. */
  minActionIntervalMs?: number;
  /** Finishers that win / end the race. Default 3 (spec §5). */
  winners?: number;
  /** RNG for target generation; defaults to a CSPRNG. Inject for deterministic
   *  tests only — production must NOT override it (spec §9 server authority). */
  rng?: () => number;
}

/** SECURITY: a CSPRNG so generated targets aren't predictable (spec §9). */
const cryptoRng = () => randomInt(0, 1_000_000) / 1_000_000;

export class RaceService {
  private readonly minActionIntervalMs: number;
  private readonly winners?: number;
  private readonly rng: () => number;

  private readonly races = new Map<string, Race>();
  /** raceId → host player id (the creator; the only one who may start/end). */
  private readonly hosts = new Map<string, string>();
  private readonly connections = new Map<string, Connection>();
  private readonly raceConnections = new Map<string, Set<string>>();

  constructor(opts: RaceServiceOptions = {}) {
    this.minActionIntervalMs = opts.minActionIntervalMs ?? 250;
    this.winners = opts.winners;
    this.rng = opts.rng ?? cryptoRng;
  }

  /** Register a new connection. Returns its server-assigned connection id. */
  connect(send: RaceSend): string {
    const id = randomUUID();
    this.connections.set(id, { id, send, raceId: null, playerId: null, lastActionAt: 0 });
    return id;
  }

  /** Dispatch one raw client frame. Never throws; protocol/game errors become
   *  `error` frames back to the sender. */
  handle(connId: string, raw: string): void {
    const conn = this.connections.get(connId);
    if (!conn) return;

    let msg: RaceClientMessage;
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
        case "end":
          return this.onEnd(conn);
        case "guess":
          return this.onGuess(conn, msg);
      }
    } catch (err) {
      const code = err instanceof RaceError ? err.code : "INTERNAL";
      conn.send({ type: "error", code, message: errMessage(err) });
    }
  }

  /** A connection dropped. A race is parallel, so this does NOT forfeit — just
   *  flag the racer disconnected so others see it; the race plays on. */
  disconnect(connId: string): void {
    const conn = this.connections.get(connId);
    if (!conn) return;
    this.connections.delete(connId);
    const { raceId, playerId } = conn;
    if (raceId) this.raceConnections.get(raceId)?.delete(connId);
    if (!raceId || !playerId) return;

    const race = this.races.get(raceId);
    if (!race || race.status !== "active") return;
    try {
      race.setConnected(playerId, false);
    } catch {
      return; // not a racer
    }
    this.broadcastState(raceId);
  }

  /** No long-lived timers to clear, but kept for a uniform service surface. */
  shutdown(): void {
    /* no-op: the race transport holds no wall-clock timers */
  }

  // --- handlers -----------------------------------------------------------
  private onCreate(conn: Connection, msg: Extract<RaceClientMessage, { type: "create" }>): void {
    if (conn.raceId) throw new RaceError("ALREADY_IN_RACE", "this connection is already in a race");
    const displayName = requireName(msg.displayName);
    const raceId = randomUUID();
    // Race() validates difficultyLength (BAD_LENGTH) and generates a CSPRNG target.
    const race = new Race({
      id: raceId,
      difficultyLength: msg.difficultyLength ?? 4,
      rng: this.rng,
      ...(this.winners !== undefined ? { winners: this.winners } : {}),
    });
    const playerId = randomUUID();
    race.join(playerId, displayName);
    this.races.set(raceId, race);
    this.hosts.set(raceId, playerId); // the creator hosts this race
    this.bind(conn, raceId, playerId);
    conn.send({ type: "joined", raceId, playerId });
    this.broadcastState(raceId);
  }

  private onJoin(conn: Connection, msg: Extract<RaceClientMessage, { type: "join" }>): void {
    if (conn.raceId) throw new RaceError("ALREADY_IN_RACE", "this connection is already in a race");
    const displayName = requireName(msg.displayName);
    const race = this.races.get(requireString(msg.raceId, "raceId"));
    if (!race) throw new RaceError("RACE_NOT_FOUND", "no such race");
    const playerId = randomUUID();
    race.join(playerId, displayName);
    this.bind(conn, race.id, playerId);
    conn.send({ type: "joined", raceId: race.id, playerId });
    this.broadcastState(race.id);
  }

  private onStart(conn: Connection): void {
    const { race, playerId } = this.requireSeat(conn);
    this.assertHost(race, playerId);
    race.start();
    this.broadcastState(race.id);
  }

  private onEnd(conn: Connection): void {
    const { race, playerId } = this.requireSeat(conn);
    this.assertHost(race, playerId);
    race.end();
    this.finishUp(race.id);
  }

  private onGuess(conn: Connection, msg: Extract<RaceClientMessage, { type: "guess" }>): void {
    this.rateLimit(conn);
    const { race, playerId } = this.requireSeat(conn);
    const result = race.guess(playerId, requireString(msg.value, "value"));
    conn.send({ type: "scored", result });
    if (race.status === "finished") this.finishUp(race.id);
    else this.broadcastState(race.id);
  }

  // --- broadcast helpers --------------------------------------------------
  private finishUp(raceId: string): void {
    const race = this.races.get(raceId);
    if (!race) return;
    this.broadcastState(raceId); // final state (target already cleared by the engine)
    this.broadcast(raceId, { type: "over", winnerId: race.winnerId, results: race.results() });
  }

  private broadcastState(raceId: string): void {
    const race = this.races.get(raceId);
    if (!race) return;
    for (const connId of this.raceConnections.get(raceId) ?? []) {
      const conn = this.connections.get(connId);
      if (conn) conn.send({ type: "state", race: race.viewFor(conn.playerId) });
    }
  }

  private broadcast(raceId: string, msg: RaceServerMessage): void {
    for (const connId of this.raceConnections.get(raceId) ?? []) {
      this.connections.get(connId)?.send(msg);
    }
  }

  // --- small guards -------------------------------------------------------
  private bind(conn: Connection, raceId: string, playerId: string): void {
    conn.raceId = raceId;
    conn.playerId = playerId;
    let set = this.raceConnections.get(raceId);
    if (!set) {
      set = new Set();
      this.raceConnections.set(raceId, set);
    }
    set.add(conn.id);
  }

  private requireSeat(conn: Connection): { race: Race; playerId: string } {
    if (!conn.raceId || !conn.playerId) throw new RaceError("NO_SEAT", "join a race first");
    const race = this.races.get(conn.raceId);
    if (!race) throw new RaceError("RACE_NOT_FOUND", "race no longer exists");
    return { race, playerId: conn.playerId };
  }

  /** Host = the creator. Tracked at create time (the race view has no roster). */
  private assertHost(race: Race, playerId: string): void {
    if (this.hosts.get(race.id) !== playerId) {
      throw new RaceError("NOT_HOST", "only the host can do that");
    }
  }

  private rateLimit(conn: Connection): void {
    const now = Date.now();
    if (now - conn.lastActionAt < this.minActionIntervalMs) {
      throw new RaceError("RATE_LIMITED", "slow down");
    }
    conn.lastActionAt = now;
  }

  private parse(raw: string): RaceClientMessage {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || !("type" in data)) {
      throw new Error("message must be an object with a type");
    }
    const type = (data as { type: unknown }).type;
    if (type !== "create" && type !== "join" && type !== "start" && type !== "end" && type !== "guess") {
      throw new Error(`unknown message type: ${String(type)}`);
    }
    // reason: field-level shape is checked per-handler (requireString / requireName
    // / engine validation); this narrows only the discriminant.
    return data as RaceClientMessage;
  }
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string") throw new RaceError("BAD_FIELD", `${field} must be a string`);
  return v;
}

function requireName(v: unknown): string {
  const s = requireString(v, "displayName").trim();
  if (s.length === 0 || s.length > 40) {
    throw new RaceError("BAD_FIELD", "displayName must be 1-40 characters");
  }
  return s;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
