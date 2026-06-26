// =============================================================================
// Dead & Wounded — Category 1 Elimination Ring engine (platform spec §4)
// =============================================================================
// N players arranged in a ring, each targeting the next (P1→P2→…→Pn→P1). On your
// turn you guess your CURRENT target's secret; crack it and that player is
// ELIMINATED, the ring RE-CLOSES (you inherit their target), and you gain read
// access to the eliminated player's session guess history (the §4 reward —
// session-scoped, nobody else's). Last player standing wins.
//
// Like `Duel`, this is a framework-independent core: no sockets, no DB, no wall
// clock of its own (time is injected). All game authority lives here so the same
// logic backs the WebSocket transport (apps/game-server) and the SMS module
// (apps/api/src/game/ring.service.ts, spec §10 persistence). Timers — the 60s
// turn limit and the 15s warning — live in the transport; this exposes only the
// pure transitions it drives (`timeoutTurn`), exactly as `Duel` does.
//
// Server-authority guarantees (spec §9, non-negotiable):
//   - Secrets are held server-side only and NEVER appear in any view. (Unlike the
//     duel, a ring never reveals secrets — the §4 reward is the inherited guess
//     history, and the durable core clears secrets on finish.)
//   - Turn order, scoring, the ring re-close, and win detection are computed here;
//     a client can never guess out of turn or score its own guess.
//   - Every secret and guess is validated through the engine before use.
// =============================================================================

import {
  type DeadWoundedResult,
  type DifficultyLength,
  isDifficultyLength,
  isWin,
  score,
  validate,
} from "./scoring";

export type RingStatus = "lobby" | "setup" | "active" | "finished" | "abandoned";
export type RingOutcome = "WON" | "ELIMINATED" | "FORFEIT";

/** Typed game-flow error; the transport maps `code` to a protocol error frame. */
export class RingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RingError";
  }
}

/** One recorded guess (a player's move at their CURRENT target's secret). */
export interface RingGuessRecord {
  guesserId: string;
  /** Whose secret was guessed (the guesser's target at the time). */
  targetId: string;
  value: string;
  dead: number;
  wounded: number;
  /** Injected timestamp (ms). The core never reads the clock itself. */
  at: number;
}

/** Server-internal player state. `secret` NEVER leaves the server. */
interface PlayerState {
  id: string;
  displayName: string;
  secret: string | null;
  connected: boolean;
  /** Who this player currently targets (the next live player around the ring). */
  targetId: string | null;
  eliminated: boolean;
  /** Who cracked this player (scopes the §4 inherited-history reward); null when
   *  the player left by timeout/forfeit (no inheritor). */
  eliminatedById: string | null;
  guesses: RingGuessRecord[];
  consecutiveMisses: number;
  /** Final placing once out (1 = winner; first eliminated = N). */
  rank: number | null;
  outcome: RingOutcome | null;
}

/** Redacted, client-safe view of a player. Carries no secret and no live target. */
export interface RingPlayerView {
  id: string;
  displayName: string;
  connected: boolean;
  ready: boolean;
  eliminated: boolean;
  rank: number | null;
  guessCount: number;
}

/** A guess as exposed to a viewer entitled to see it (own + inherited). */
export interface RingGuessView {
  guesserId: string;
  targetId: string;
  value: string;
  dead: number;
  wounded: number;
  at: number;
}

/** The §4 reward: a player's guess history, revealed to whoever eliminated them. */
export interface InheritedHistoryView {
  fromPlayerId: string;
  fromDisplayName: string;
  guesses: RingGuessView[];
}

/** Redacted, client-safe view of the whole ring. Contains no secrets. */
export interface RingView {
  id: string;
  difficultyLength: DifficultyLength;
  status: RingStatus;
  currentTurnPlayerId: string | null;
  winnerId: string | null;
  you: string | null;
  /** The viewer's current target (only while they're alive and the ring is active). */
  yourTargetId: string | null;
  players: RingPlayerView[];
  /** ONLY the viewer's own guesses. */
  yourGuesses: RingGuessView[];
  /** Guess histories of players the viewer eliminated (§4). */
  inheritedHistories: InheritedHistoryView[];
}

/** Per-player outcome for persistence/standings (spec §10 GameResult). */
export interface RingResult {
  playerId: string;
  outcome: RingOutcome;
  guessCount: number;
  rank: number;
}

export interface RingOptions {
  id: string;
  difficultyLength: number;
  /** Minimum players to start. Default 3 (spec §4: a 2-player ring is a duel). */
  minPlayers?: number;
  /** Maximum players the ring will seat. Default 10. */
  maxPlayers?: number;
  /** Consecutive missed turns (timeouts) before a player forfeits. Default 3. */
  maxConsecutiveMisses?: number;
  now?: number;
}

export class Ring {
  readonly id: string;
  readonly difficultyLength: DifficultyLength;
  status: RingStatus = "lobby";
  winnerId: string | null = null;
  currentTurnPlayerId: string | null = null;
  readonly createdAt: number;
  startedAt: number | null = null;
  finishedAt: number | null = null;

  private readonly players: PlayerState[] = [];
  private readonly minPlayers: number;
  private readonly maxPlayers: number;
  private readonly maxConsecutiveMisses: number;

  constructor(opts: RingOptions) {
    if (!isDifficultyLength(opts.difficultyLength)) {
      throw new RingError("BAD_LENGTH", "difficultyLength must be 4, 5, or 6");
    }
    this.id = opts.id;
    this.difficultyLength = opts.difficultyLength;
    this.minPlayers = opts.minPlayers ?? 3;
    this.maxPlayers = opts.maxPlayers ?? 10;
    this.maxConsecutiveMisses = opts.maxConsecutiveMisses ?? 3;
    this.createdAt = opts.now ?? Date.now();
  }

  // --- lobby --------------------------------------------------------------
  /** Seat a player in the lobby (join order fixes the ring order). */
  join(playerId: string, displayName: string): void {
    if (this.status !== "lobby") throw new RingError("NOT_LOBBY", "ring is not accepting players");
    if (this.players.some((p) => p.id === playerId)) {
      throw new RingError("ALREADY_JOINED", "player already in this ring");
    }
    if (this.players.length >= this.maxPlayers) throw new RingError("FULL", "ring is full");
    this.players.push({
      id: playerId,
      displayName,
      secret: null,
      connected: true,
      targetId: null,
      eliminated: false,
      eliminatedById: null,
      guesses: [],
      consecutiveMisses: 0,
      rank: null,
      outcome: null,
    });
  }

  /** Lock the roster and move to secret submission (needs ≥ minPlayers). */
  start(): void {
    if (this.status !== "lobby") throw new RingError("NOT_LOBBY", "ring is not in the lobby");
    if (this.players.length < this.minPlayers) {
      throw new RingError("TOO_FEW", `a ring needs at least ${this.minPlayers} players`);
    }
    this.status = "setup";
  }

  // --- setup --------------------------------------------------------------
  /** Submit this player's secret. All secrets in → the ring activates. */
  submitSecret(playerId: string, secret: string, now?: number): void {
    if (this.status !== "setup") throw new RingError("NOT_SETUP", "not in the secret-setup phase");
    const me = this.requirePlayer(playerId);
    if (me.secret !== null) throw new RingError("SECRET_SET", "secret already submitted");
    if (!validate(secret, this.difficultyLength)) {
      throw new RingError(
        "INVALID_SECRET",
        `secret must be ${this.difficultyLength} distinct digits 0-9`,
      );
    }
    me.secret = secret;
    if (this.players.every((p) => p.secret !== null)) this.activate(now);
  }

  /** Form the ring: each player (in join order) targets the next; P0 starts. */
  private activate(now?: number): void {
    const n = this.players.length;
    for (let i = 0; i < n; i++) {
      const me = this.players[i] as PlayerState;
      me.targetId = (this.players[(i + 1) % n] as PlayerState).id;
    }
    this.status = "active";
    this.startedAt = now ?? this.createdAt;
    this.currentTurnPlayerId = (this.players[0] as PlayerState).id;
  }

  // --- play ---------------------------------------------------------------
  /**
   * Take your turn: guess your CURRENT target's secret. Server-authoritative —
   * enforces the active state and your turn, validates and scores the guess, and
   * on a crack eliminates the target, re-closes the ring (you inherit their
   * target), and advances play. Returns the score — NEVER the secret.
   */
  guess(playerId: string, value: string, now?: number): DeadWoundedResult {
    if (this.status !== "active") throw new RingError("NOT_ACTIVE", "ring is not in play");
    if (this.currentTurnPlayerId !== playerId) throw new RingError("NOT_YOUR_TURN", "not your turn");
    const me = this.requirePlayer(playerId);
    if (me.eliminated) throw new RingError("ELIMINATED", "you have been eliminated");
    if (!validate(value, this.difficultyLength)) {
      throw new RingError(
        "INVALID_GUESS",
        `guess must be ${this.difficultyLength} distinct digits 0-9`,
      );
    }
    const target = me.targetId ? this.players.find((p) => p.id === me.targetId) : undefined;
    if (!target || target.eliminated || target.secret === null) {
      throw new RingError("NO_TARGET", "no valid target");
    }
    const result = score(value, target.secret);
    me.guesses.push({
      guesserId: me.id,
      targetId: target.id,
      value,
      dead: result.dead,
      wounded: result.wounded,
      at: now ?? Date.now(),
    });
    me.consecutiveMisses = 0; // showing up resets the timeout counter

    if (isWin(result, this.difficultyLength)) {
      const finished = this.eliminate(target.id, me.id, "ELIMINATED", now);
      if (!finished) this.advanceTurn(me.id); // me now targets the re-closed next
    } else {
      this.advanceTurn(me.id);
    }
    return result;
  }

  /**
   * The current player's turn elapsed without a guess (the transport's timer
   * fired). Graduated per spec §4: misses 1–2 skip the turn; miss 3 forfeits the
   * stalling player. Time/timers live in the transport; this is the pure
   * transition it calls.
   */
  timeoutTurn(now?: number): void {
    if (this.status !== "active" || this.currentTurnPlayerId === null) {
      throw new RingError("NOT_ACTIVE", "no active turn to time out");
    }
    const current = this.requirePlayer(this.currentTurnPlayerId);
    current.consecutiveMisses += 1;
    if (current.consecutiveMisses >= this.maxConsecutiveMisses) {
      const finished = this.eliminate(current.id, null, "FORFEIT", now);
      if (!finished) this.advanceTurn(current.id); // to current's successor
    } else {
      this.advanceTurn(current.id); // skip; player stays in the ring
    }
  }

  /** Voluntarily quit an active ring; the ring re-closes around you. */
  forfeit(playerId: string, now?: number): void {
    if (this.status !== "active") throw new RingError("NOT_ACTIVE", "ring is not in play");
    const me = this.requirePlayer(playerId);
    if (me.eliminated) throw new RingError("ELIMINATED", "you have been eliminated");
    const finished = this.eliminate(me.id, null, "FORFEIT", now);
    if (!finished && this.currentTurnPlayerId === me.id) this.advanceTurn(me.id);
  }

  /** Moderator force-ends a ring (abandoned / stuck). No winner is declared. */
  abandon(now?: number): void {
    if (this.status === "finished" || this.status === "abandoned") {
      throw new RingError("NOT_RUNNING", "ring is already over");
    }
    this.status = "abandoned";
    this.currentTurnPlayerId = null;
    this.finishedAt = now ?? Date.now();
    for (const p of this.players) p.secret = null; // retention: clear secrets (§10)
  }

  /** Mark connection state (the transport calls this on connect/disconnect). */
  setConnected(playerId: string, connected: boolean): void {
    this.requirePlayer(playerId).connected = connected;
  }

  // --- views (redacted) ---------------------------------------------------
  /**
   * Client-safe view. SECURITY (§9): no secret ever appears. The viewer sees ONLY
   * their own guesses, plus the inherited histories of players THEY eliminated
   * (§4); other live players' guesses are never serialized.
   */
  viewFor(viewerId: string | null = null): RingView {
    const me = viewerId ? this.players.find((p) => p.id === viewerId) ?? null : null;
    const toGuessView = (g: RingGuessRecord): RingGuessView => ({
      guesserId: g.guesserId,
      targetId: g.targetId,
      value: g.value,
      dead: g.dead,
      wounded: g.wounded,
      at: g.at,
    });

    const inheritedHistories: InheritedHistoryView[] = [];
    if (me) {
      for (const p of this.players) {
        if (p.eliminatedById === me.id) {
          inheritedHistories.push({
            fromPlayerId: p.id,
            fromDisplayName: p.displayName,
            guesses: p.guesses.map(toGuessView),
          });
        }
      }
    }

    return {
      id: this.id,
      difficultyLength: this.difficultyLength,
      status: this.status,
      currentTurnPlayerId: this.currentTurnPlayerId,
      winnerId: this.winnerId,
      you: me?.id ?? null,
      yourTargetId: me && !me.eliminated && this.status === "active" ? me.targetId : null,
      players: this.players.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        connected: p.connected,
        ready: p.secret !== null,
        eliminated: p.eliminated,
        rank: p.rank,
        guessCount: p.guesses.length,
      })),
      yourGuesses: me ? me.guesses.map(toGuessView) : [],
      inheritedHistories,
    };
  }

  /** Per-player results for persistence/standings (spec §10). Finished rings only. */
  results(): RingResult[] {
    if (this.status !== "finished") {
      throw new RingError("NOT_FINISHED", "results are only available once finished");
    }
    return this.players.map((p) => ({
      playerId: p.id,
      outcome: (p.outcome ?? "ELIMINATED") as RingOutcome,
      guessCount: p.guesses.length,
      rank: p.rank ?? this.players.length,
    }));
  }

  // --- internals ----------------------------------------------------------
  /**
   * Eliminate `victimId`, re-close the ring (their predecessor inherits their
   * target), and record the placing (reverse elimination order). Returns true if
   * this ended the ring (one player left → winner).
   */
  private eliminate(
    victimId: string,
    byPlayerId: string | null,
    outcome: "ELIMINATED" | "FORFEIT",
    now?: number,
  ): boolean {
    const active = this.players.filter((p) => !p.eliminated);
    const victim = active.find((p) => p.id === victimId);
    if (!victim) return false;
    // Ring re-close: whoever targeted the victim now targets the victim's target.
    const predecessor = active.find((p) => p.targetId === victimId && p.id !== victimId);
    if (predecessor && victim.targetId) predecessor.targetId = victim.targetId;

    victim.eliminated = true;
    victim.eliminatedById = byPlayerId;
    const remaining = active.length - 1;
    // First out finishes last: with `remaining` players left AFTER this removal,
    // the victim places `remaining + 1`.
    victim.rank = remaining + 1;
    victim.outcome = outcome;

    if (remaining <= 1) {
      const winner = active.find((p) => p.id !== victimId);
      if (winner) this.finishRing(winner, now);
      return true;
    }
    return false;
  }

  private finishRing(winner: PlayerState, now?: number): void {
    winner.rank = 1;
    winner.outcome = "WON";
    this.status = "finished";
    this.winnerId = winner.id;
    this.currentTurnPlayerId = null;
    this.finishedAt = now ?? Date.now();
    for (const p of this.players) p.secret = null; // retention: clear secrets (§10)
  }

  /** Pass the turn to whoever `fromPlayerId` now targets (the next live player
   *  around the re-closed ring). */
  private advanceTurn(fromPlayerId: string): void {
    const from = this.players.find((p) => p.id === fromPlayerId);
    if (!from?.targetId) return;
    this.currentTurnPlayerId = from.targetId;
  }

  private requirePlayer(playerId: string): PlayerState {
    const p = this.players.find((x) => x.id === playerId);
    if (!p) throw new RingError("NOT_A_PLAYER", "you are not in this ring");
    return p;
  }
}
