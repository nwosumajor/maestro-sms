// =============================================================================
// Dead & Wounded — server-authoritative 2-player match (platform spec §11 step 2)
// =============================================================================
// The 2-player "duel" built ON TOP OF the pure scoring engine. This is still a
// framework-independent core: no sockets, no DB, no wall clock of its own (time
// is injected). All game authority lives here so it is provably correct and so
// the WebSocket transport (apps/game-server) and the later NestJS/SMS module
// (spec §10) can both drive the SAME logic.
//
// Server-authority guarantees (spec §9, non-negotiable):
//   - Secrets are held server-side only and NEVER appear in a view sent to the
//     opponent. Both secrets are revealed only once the game is finished.
//   - Turn order, scoring, and win detection are computed here; a client can
//     never guess out of turn or score its own guess.
//   - Every secret and guess is validated through the engine before use.
//
// The in-memory shapes intentionally mirror the §10 persistence model
// (GamePlayer.secret, Guess.{value,dead,wounded}, GameResult.{outcome,rank}) so
// step 3 (SMS persistence) is a wiring job, not a redesign.
// =============================================================================

import {
  type DeadWoundedResult,
  type DifficultyLength,
  isDifficultyLength,
  isWin,
  score,
  validate,
} from "./scoring";

export type DuelStatus = "lobby" | "setup" | "active" | "finished" | "abandoned";
export type DuelOutcome = "WON" | "LOST" | "FORFEIT";

/** Typed game-flow error; the transport maps `code` to a protocol error frame. */
export class DuelError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    // The code is part of the message so logs/tests carry it; the transport maps
    // the structured `code` (not the prose) to a protocol error frame.
    super(`${code}: ${message}`);
    this.name = "DuelError";
  }
}

/** One recorded guess (a player's move at the OPPONENT's secret). */
export interface GuessRecord {
  value: string;
  dead: number;
  wounded: number;
  /** Injected timestamp (ms). The core never reads the clock itself. */
  at: number;
}

/** Server-internal player state. `secret` NEVER leaves the server while active. */
interface PlayerState {
  id: string;
  displayName: string;
  secret: string | null;
  connected: boolean;
  guesses: GuessRecord[];
  consecutiveMisses: number;
}

/** Redacted, client-safe view of a player (see `Duel.viewFor`). */
export interface PlayerView {
  id: string;
  displayName: string;
  connected: boolean;
  ready: boolean;
  guessCount: number;
  /** The viewer always sees the full history of guesses they can know about. */
  guesses: GuessRecord[];
  /** Present ONLY when the game is finished — secrets are revealed at the end. */
  secret?: string;
}

/** Redacted, client-safe view of the whole match. Contains no live secrets. */
export interface DuelView {
  id: string;
  difficultyLength: DifficultyLength;
  status: DuelStatus;
  currentTurnPlayerId: string | null;
  winnerId: string | null;
  you: string | null;
  players: PlayerView[];
}

/** Per-player outcome for persistence/standings (spec §10 GameResult). */
export interface PlayerResult {
  playerId: string;
  outcome: DuelOutcome;
  guessCount: number;
  rank: 1 | 2;
}

export interface DuelOptions {
  id: string;
  difficultyLength: number;
  /** Injected so first-turn selection is deterministic in tests. */
  rng?: () => number;
  /** Consecutive missed turns (timeouts) before a player forfeits. */
  maxConsecutiveMisses?: number;
  now?: number;
}

export class Duel {
  readonly id: string;
  readonly difficultyLength: DifficultyLength;
  status: DuelStatus = "lobby";
  winnerId: string | null = null;
  currentTurnPlayerId: string | null = null;
  readonly createdAt: number;
  startedAt: number | null = null;
  finishedAt: number | null = null;

  private readonly players: PlayerState[] = [];
  private readonly rng: () => number;
  private readonly maxConsecutiveMisses: number;

  constructor(opts: DuelOptions) {
    if (!isDifficultyLength(opts.difficultyLength)) {
      throw new DuelError("BAD_LENGTH", "difficultyLength must be 4, 5, or 6");
    }
    this.id = opts.id;
    this.difficultyLength = opts.difficultyLength;
    this.rng = opts.rng ?? Math.random;
    this.maxConsecutiveMisses = opts.maxConsecutiveMisses ?? 3;
    this.createdAt = opts.now ?? Date.now();
  }

  // --- lobby --------------------------------------------------------------
  /** Add a player to the lobby. Two players → setup phase. */
  join(playerId: string, displayName: string): void {
    if (this.players.some((p) => p.id === playerId)) {
      throw new DuelError("ALREADY_JOINED", "player already in this game");
    }
    if (this.players.length >= 2) throw new DuelError("FULL", "game already has two players");
    if (this.status !== "lobby") throw new DuelError("NOT_LOBBY", "game is not accepting players");
    this.players.push({
      id: playerId,
      displayName,
      secret: null,
      connected: true,
      guesses: [],
      consecutiveMisses: 0,
    });
    if (this.players.length === 2) this.status = "setup";
  }

  // --- setup --------------------------------------------------------------
  /** Submit this player's secret. Both secrets set → game activates. */
  submitSecret(playerId: string, secret: string): void {
    if (this.status !== "setup") throw new DuelError("NOT_SETUP", "not in the secret-setup phase");
    const me = this.requirePlayer(playerId);
    if (me.secret !== null) throw new DuelError("SECRET_SET", "secret already submitted");
    if (!validate(secret, this.difficultyLength)) {
      throw new DuelError(
        "INVALID_SECRET",
        `secret must be ${this.difficultyLength} distinct digits 0-9`,
      );
    }
    me.secret = secret;
    if (this.players.every((p) => p.secret !== null)) this.activate();
  }

  private activate(now?: number): void {
    this.status = "active";
    this.startedAt = now ?? this.createdAt;
    // SECURITY: random first mover keeps going-first a coin flip, not an exploit.
    const first = this.rng() < 0.5 ? 0 : 1;
    this.currentTurnPlayerId = (this.players[first] as PlayerState).id;
  }

  // --- play ---------------------------------------------------------------
  /**
   * Submit a guess at the OPPONENT's secret. Server-authoritative: enforces the
   * active state and the turn, validates the guess, scores it via the engine,
   * records it, and ends the game on a crack. Returns the score for broadcast —
   * NEVER the secret.
   */
  guess(playerId: string, value: string, now?: number): DeadWoundedResult {
    if (this.status !== "active") throw new DuelError("NOT_ACTIVE", "game is not in play");
    if (this.currentTurnPlayerId !== playerId) throw new DuelError("NOT_YOUR_TURN", "not your turn");
    const me = this.requirePlayer(playerId);
    const opponent = this.opponentOf(playerId);
    if (!validate(value, this.difficultyLength)) {
      throw new DuelError(
        "INVALID_GUESS",
        `guess must be ${this.difficultyLength} distinct digits 0-9`,
      );
    }
    // opponent.secret is guaranteed set: the game only reaches "active" once both
    // secrets exist. Score the guess against it on the server.
    const result = score(value, opponent.secret as string);
    me.guesses.push({ value, dead: result.dead, wounded: result.wounded, at: now ?? Date.now() });
    me.consecutiveMisses = 0;

    if (isWin(result, this.difficultyLength)) {
      this.finish(playerId, now);
    } else {
      this.currentTurnPlayerId = opponent.id;
    }
    return result;
  }

  /**
   * The current player's turn elapsed without a guess. They miss; after
   * `maxConsecutiveMisses` consecutive misses they forfeit (opponent wins).
   * Otherwise the turn passes on. Time/timers live in the transport; this is the
   * pure transition it calls. (Graduated skip→forfeit per spec §9 rationale.)
   */
  timeoutTurn(now?: number): void {
    if (this.status !== "active" || this.currentTurnPlayerId === null) {
      throw new DuelError("NOT_ACTIVE", "no active turn to time out");
    }
    const me = this.requirePlayer(this.currentTurnPlayerId);
    me.consecutiveMisses += 1;
    if (me.consecutiveMisses >= this.maxConsecutiveMisses) {
      this.finish(this.opponentOf(me.id).id, now);
    } else {
      this.currentTurnPlayerId = this.opponentOf(me.id).id;
    }
  }

  /** A player abandons the match; the opponent wins by forfeit. */
  forfeit(playerId: string, now?: number): void {
    if (this.status !== "active" && this.status !== "setup") {
      throw new DuelError("NOT_RUNNING", "game is not running");
    }
    this.requirePlayer(playerId);
    this.finish(this.opponentOf(playerId).id, now);
  }

  private finish(winnerId: string, now?: number): void {
    this.status = "finished";
    this.winnerId = winnerId;
    this.finishedAt = now ?? Date.now();
    this.currentTurnPlayerId = null;
  }

  /** Mark connection state (transport calls this on connect/disconnect). */
  setConnected(playerId: string, connected: boolean): void {
    this.requirePlayer(playerId).connected = connected;
  }

  // --- views (redacted) ---------------------------------------------------
  /**
   * Client-safe view. While the game is live, NO secret appears in the output
   * for anyone (you already know your own; the opponent must never learn it).
   * Both secrets are revealed only once `status === "finished"`.
   */
  viewFor(viewerId: string | null = null): DuelView {
    const reveal = this.status === "finished";
    return {
      id: this.id,
      difficultyLength: this.difficultyLength,
      status: this.status,
      currentTurnPlayerId: this.currentTurnPlayerId,
      winnerId: this.winnerId,
      you: viewerId,
      players: this.players.map((p) => {
        const view: PlayerView = {
          id: p.id,
          displayName: p.displayName,
          connected: p.connected,
          ready: p.secret !== null,
          guessCount: p.guesses.length,
          guesses: p.guesses.map((g) => ({ ...g })),
        };
        if (reveal && p.secret !== null) view.secret = p.secret;
        return view;
      }),
    };
  }

  /** Per-player results for persistence/standings (spec §10). */
  results(): PlayerResult[] {
    if (this.status !== "finished" || this.winnerId === null) {
      throw new DuelError("NOT_FINISHED", "results are only available once finished");
    }
    return this.players.map((p) => ({
      playerId: p.id,
      outcome: p.id === this.winnerId ? "WON" : ("LOST" as DuelOutcome),
      guessCount: p.guesses.length,
      rank: p.id === this.winnerId ? 1 : 2,
    }));
  }

  // --- helpers ------------------------------------------------------------
  private requirePlayer(playerId: string): PlayerState {
    const p = this.players.find((x) => x.id === playerId);
    if (!p) throw new DuelError("NOT_A_PLAYER", "you are not in this game");
    return p;
  }

  private opponentOf(playerId: string): PlayerState {
    const other = this.players.find((x) => x.id !== playerId);
    if (!other) throw new DuelError("NO_OPPONENT", "opponent not present");
    return other;
  }
}
