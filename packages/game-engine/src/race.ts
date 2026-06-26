// =============================================================================
// Dead & Wounded — Category 2 Class Race engine (platform spec §5)
// =============================================================================
// One shared target secret; every player races in PARALLEL (no turns) to crack
// it, and the FIRST THREE to score N dead win (1st/2nd/3rd). Ranking within a
// single race is by FINISH ORDER (who cracked first) — the spec §5 "who reaches N
// dead first". (The cross-class tournament's combined, time-independent ranking
// via `computeRaceStandings` is a layer ABOVE this, in the SMS service; this
// engine just records each finisher's order + guessCount + own-start elapsedMs,
// which is exactly the `RaceFinish` shape that ranking consumes.)
//
// Like `Duel`/`Ring`, this is a framework-independent core: no sockets, no DB, no
// wall clock of its own (time is injected). All authority lives here so the same
// logic backs the WebSocket transport (apps/game-server) and the SMS module
// (apps/api/src/game/race.service.ts, spec §10 persistence).
//
// Server-authority guarantees (spec §9, non-negotiable):
//   - The shared target is held server-side only and is NEVER serialized — not
//     even to the host; it is cleared once the race is over.
//   - Scoring, finish order, and the top-3 are computed here; clients are
//     display-only. A racer sees ONLY their own guesses; others' in-progress
//     guesses are never exposed.
//   - Every guess is validated through the engine before use.
// Rate-limiting (anti-abuse §5) is a wall-clock concern owned by the transport,
// exactly as turn timers are for the duel/ring.
// =============================================================================

import {
  type DeadWoundedResult,
  type DifficultyLength,
  generateSecret,
  isDifficultyLength,
  isWin,
  score,
  validate,
} from "./scoring";

export type RaceStatus = "lobby" | "active" | "finished" | "abandoned";

/** Typed game-flow error; the transport maps `code` to a protocol error frame. */
export class RaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RaceError";
  }
}

/** One recorded guess at the shared target. */
export interface RaceGuessRecord {
  value: string;
  dead: number;
  wounded: number;
  /** Injected timestamp (ms). The core never reads the clock itself. */
  at: number;
}

/** A finisher's locked-in placing (spec §5: finish order + the §5 metrics). */
export interface RaceFinishRecord {
  rank: number;
  guessCount: number;
  /** Elapsed ms from this race's start (own-start basis, §5). */
  elapsedMs: number;
}

/** Server-internal racer state. */
interface RacePlayerState {
  id: string;
  displayName: string;
  connected: boolean;
  guesses: RaceGuessRecord[];
  finish: RaceFinishRecord | null;
}

/** Redacted, client-safe view of a racer. Carries no guesses of others. */
export interface RacePlayerView {
  id: string;
  displayName: string;
  connected: boolean;
  guessCount: number;
  finished: boolean;
  rank: number | null;
}

/** A finisher on the public leaderboard (finishers only — never live progress). */
export interface RaceFinisherView {
  playerId: string;
  displayName: string;
  rank: number;
  guessCount: number;
  elapsedMs: number;
}

/** Redacted, client-safe view of the whole race. Never contains the target. */
export interface RaceView {
  id: string;
  difficultyLength: DifficultyLength;
  status: RaceStatus;
  startedAt: number | null;
  finishedAt: number | null;
  participantCount: number;
  you: string | null;
  /** ONLY the viewer's own guesses. */
  yourGuesses: RaceGuessRecord[];
  /** The viewer's own locked-in placing, once they've cracked it. */
  yourFinish: RaceFinishRecord | null;
  /** Finishers only, in finish order. */
  leaderboard: RaceFinisherView[];
  winnerId: string | null;
}

/** Per-finisher outcome for persistence/standings (spec §10 GameResult). */
export interface RaceResult {
  playerId: string;
  rank: number;
  guessCount: number;
  elapsedMs: number;
  outcome: "WON";
}

export interface RaceOptions {
  id: string;
  difficultyLength: number;
  /** An explicit shared target (validated). Omit to generate one. */
  target?: string;
  /** RNG for target generation; inject a CSPRNG in production (default Math.random). */
  rng?: () => number;
  /** How many finishers win / end the race (spec §5: 1st/2nd/3rd). Default 3. */
  winners?: number;
  now?: number;
}

export class Race {
  readonly id: string;
  readonly difficultyLength: DifficultyLength;
  status: RaceStatus = "lobby";
  winnerId: string | null = null;
  readonly createdAt: number;
  startedAt: number | null = null;
  finishedAt: number | null = null;

  // SECURITY (§9): server-only; NEVER serialized, cleared on finish/abandon.
  private target: string | null;
  private readonly players: RacePlayerState[] = [];
  private readonly winners: number;

  constructor(opts: RaceOptions) {
    if (!isDifficultyLength(opts.difficultyLength)) {
      throw new RaceError("BAD_LENGTH", "difficultyLength must be 4, 5, or 6");
    }
    this.id = opts.id;
    this.difficultyLength = opts.difficultyLength;
    this.winners = opts.winners ?? 3;
    this.createdAt = opts.now ?? Date.now();
    const target = opts.target ?? generateSecret(opts.difficultyLength, opts.rng);
    if (!validate(target, opts.difficultyLength)) {
      throw new RaceError("INVALID_TARGET", `target must be ${opts.difficultyLength} distinct digits 0-9`);
    }
    this.target = target;
  }

  // --- lobby --------------------------------------------------------------
  /** Seat a racer in the lobby. */
  join(playerId: string, displayName: string): void {
    if (this.status !== "lobby") throw new RaceError("NOT_LOBBY", "race is not open to join");
    if (this.players.some((p) => p.id === playerId)) {
      throw new RaceError("ALREADY_JOINED", "you are already in this race");
    }
    this.players.push({ id: playerId, displayName, connected: true, guesses: [], finish: null });
  }

  /** Host starts the race: everyone's clock starts now (spec §5 own-start). */
  start(now?: number): void {
    if (this.status !== "lobby") throw new RaceError("NOT_LOBBY", "race is not in the lobby");
    if (this.players.length < 1) throw new RaceError("TOO_FEW", "no participants have joined");
    this.status = "active";
    this.startedAt = now ?? this.createdAt;
  }

  // --- play ---------------------------------------------------------------
  /**
   * Submit a guess at the shared target. Server-authoritative: enforces the active
   * state, that you haven't already finished, validates and scores the guess,
   * records it, and on a crack locks in your finish (rank by order). Returns the
   * score — NEVER the target.
   */
  guess(playerId: string, value: string, now?: number): DeadWoundedResult {
    if (this.status !== "active") throw new RaceError("NOT_ACTIVE", "race is not in play");
    const me = this.requirePlayer(playerId);
    if (me.finish) throw new RaceError("ALREADY_FINISHED", "you have already finished this race");
    if (!validate(value, this.difficultyLength)) {
      throw new RaceError("INVALID_GUESS", `guess must be ${this.difficultyLength} distinct digits 0-9`);
    }
    // target is non-null while active (only cleared on finish/abandon).
    const result = score(value, this.target as string);
    me.guesses.push({ value, dead: result.dead, wounded: result.wounded, at: now ?? Date.now() });
    if (isWin(result, this.difficultyLength)) this.recordFinish(me, now);
    return result;
  }

  /** Host ends the race early; current finishers keep their ranks (spec §5). */
  end(now?: number): void {
    if (this.status === "finished" || this.status === "abandoned") {
      throw new RaceError("NOT_RUNNING", "race is already over");
    }
    this.finish(now);
  }

  /** Mark connection state. A disconnect does NOT forfeit — racing is parallel, so
   *  others keep going and the racer may rejoin; the transport handles reconnects. */
  setConnected(playerId: string, connected: boolean): void {
    this.requirePlayer(playerId).connected = connected;
  }

  // --- views (redacted) ---------------------------------------------------
  /**
   * Client-safe view. SECURITY (§9): the target never appears. The viewer sees
   * ONLY their own guesses; the leaderboard is finishers only (no live progress
   * of others is ever exposed).
   */
  viewFor(viewerId: string | null = null): RaceView {
    const me = viewerId ? this.players.find((p) => p.id === viewerId) ?? null : null;
    const finishers = this.players
      .filter((p) => p.finish)
      .sort((a, b) => (a.finish as RaceFinishRecord).rank - (b.finish as RaceFinishRecord).rank);

    return {
      id: this.id,
      difficultyLength: this.difficultyLength,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      participantCount: this.players.length,
      you: me?.id ?? null,
      yourGuesses: me ? me.guesses.map((g) => ({ ...g })) : [],
      yourFinish: me?.finish ? { ...me.finish } : null,
      leaderboard: finishers.map((p) => {
        const f = p.finish as RaceFinishRecord;
        return {
          playerId: p.id,
          displayName: p.displayName,
          rank: f.rank,
          guessCount: f.guessCount,
          elapsedMs: f.elapsedMs,
        };
      }),
      winnerId: this.winnerId,
    };
  }

  /** Per-finisher results for persistence/standings (spec §10). Finished races. */
  results(): RaceResult[] {
    if (this.status !== "finished" && this.status !== "abandoned") {
      throw new RaceError("NOT_FINISHED", "results are only available once the race is over");
    }
    return this.players
      .filter((p) => p.finish)
      .map((p) => {
        const f = p.finish as RaceFinishRecord;
        return { playerId: p.id, rank: f.rank, guessCount: f.guessCount, elapsedMs: f.elapsedMs, outcome: "WON" as const };
      })
      .sort((a, b) => a.rank - b.rank);
  }

  // --- internals ----------------------------------------------------------
  /** Lock in a racer's crack: rank by finish order, elapsed from the race start. */
  private recordFinish(me: RacePlayerState, now?: number): void {
    const finishedSoFar = this.players.filter((p) => p.finish).length;
    const rank = finishedSoFar + 1;
    const elapsedMs = this.startedAt ? Math.max(0, (now ?? Date.now()) - this.startedAt) : 0;
    me.finish = { rank, guessCount: me.guesses.length, elapsedMs };
    // First three decided, or everyone has cracked → the race is over (spec §5).
    if (rank >= this.winners || rank >= this.players.length) this.finish(now);
  }

  private finish(now?: number): void {
    this.status = "finished";
    this.finishedAt = now ?? Date.now();
    this.winnerId = this.players.find((p) => p.finish?.rank === 1)?.id ?? null;
    this.target = null; // retention: clear the target once the race is over (§10)
  }

  private requirePlayer(playerId: string): RacePlayerState {
    const p = this.players.find((x) => x.id === playerId);
    if (!p) throw new RaceError("NOT_A_PLAYER", "you are not in this race");
    return p;
  }
}
