// =============================================================================
// Dead & Wounded — Category 4 "Ultimate" arena engine (platform spec §7/§10)
// =============================================================================
// The PURE mechanics behind the cross-school Ultimate arena: an asynchronous,
// rolling-entry solo race. Each participant enters with a HANDLE (never a real
// name — spec §7) and gets their OWN per-entry target; they race their own clock
// to crack it, and finishers are ranked together by the time-independent §5
// metric (fewest guesses → fastest own-start elapsed) via `computeRaceStandings`.
//
// This core is deliberately GOVERNANCE-FREE and PII-FREE: it knows only opaque
// participant ids, handles, per-entry server-only secrets, and scores — exactly
// the columns the spec lets cross the tenant boundary. The two-tier consent,
// school enrollment, and the userId↔participantId bridge live ABOVE this, in the
// SMS service (apps/api/src/game/ultimate.service.ts). Like Duel/Ring/Race, time
// is injected and timers (the §10 15s get-ready countdown / hard-disconnect) live
// in the transport.
//
// Server authority (spec §9): each per-entry secret is server-only and NEVER
// serialized; scoring, finish detection, and standings are computed here.
//
// `enter` reserves a seat (status "ready"); `begin` starts that player's clock
// (after the transport's 15s countdown) so own-start elapsed is measured from the
// real race start, not the lobby. Guessing is only allowed once "racing".
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
import { computeRaceStandings, isValidHandle } from "./competition";

export type ArenaStatus = "open" | "closed";
export type ParticipantStatus = "ready" | "racing" | "finished";

/** Typed game-flow error; the transport maps `code` to a protocol error frame. */
export class ArenaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ArenaError";
  }
}

/** Server-internal participant state. `secret` NEVER leaves the server. */
interface ParticipantState {
  id: string;
  handle: string;
  secret: string | null;
  status: ParticipantStatus;
  startedAt: number | null;
  guessCount: number;
  elapsedMs: number | null;
}

/** A finisher on the cross-school leaderboard (ranked; carries only handle+scores). */
export interface ArenaStandingView {
  participantId: string;
  handle: string;
  rank: number;
  guessCount: number;
  elapsedMs: number;
}

/** The viewer's own entry. */
export interface ArenaEntryView {
  participantId: string;
  handle: string;
  status: ParticipantStatus;
  guessCount: number;
  elapsedMs: number | null;
  rank: number | null;
}

/** Redacted, client-safe view of the arena. Contains no secrets. */
export interface ArenaView {
  id: string;
  difficultyLength: DifficultyLength;
  status: ArenaStatus;
  participantCount: number;
  you: string | null;
  yourEntry: ArenaEntryView | null;
  /** Finishers only, ranked by the §5 metric. */
  leaderboard: ArenaStandingView[];
}

/** Per-finisher result for persistence/standings (spec §10). */
export interface ArenaResult {
  participantId: string;
  handle: string;
  rank: number;
  guessCount: number;
  elapsedMs: number;
}

export interface ArenaOptions {
  id: string;
  difficultyLength: number;
  /** RNG for per-entry target generation; inject a CSPRNG in production. */
  rng?: () => number;
  now?: number;
}

export class Arena {
  readonly id: string;
  readonly difficultyLength: DifficultyLength;
  status: ArenaStatus = "open";
  readonly createdAt: number;

  private readonly participants: ParticipantState[] = [];
  private readonly rng?: () => number;

  constructor(opts: ArenaOptions) {
    if (!isDifficultyLength(opts.difficultyLength)) {
      throw new ArenaError("BAD_LENGTH", "difficultyLength must be 4, 5, or 6");
    }
    this.id = opts.id;
    this.difficultyLength = opts.difficultyLength;
    this.rng = opts.rng;
    this.createdAt = opts.now ?? Date.now();
  }

  // --- entry --------------------------------------------------------------
  /** Reserve a seat with a HANDLE and a fresh per-entry target. The clock does
   *  NOT start yet — call `begin` after the transport's get-ready countdown. */
  enter(participantId: string, handle: string): void {
    if (this.status !== "open") throw new ArenaError("CLOSED", "the arena is closed");
    if (this.participants.some((p) => p.id === participantId)) {
      throw new ArenaError("ALREADY_ENTERED", "you have already entered this arena");
    }
    if (!isValidHandle(handle)) {
      throw new ArenaError("INVALID_HANDLE", "handle must be 3-24 letters/digits/space/_/-");
    }
    if (this.participants.some((p) => p.handle.toLowerCase() === handle.toLowerCase())) {
      throw new ArenaError("HANDLE_TAKEN", "that handle is already in use");
    }
    this.participants.push({
      id: participantId,
      handle,
      // SECURITY: own per-entry secret, server-only; never serialized.
      secret: generateSecret(this.difficultyLength, this.rng),
      status: "ready",
      startedAt: null,
      guessCount: 0,
      elapsedMs: null,
    });
  }

  /** Start this participant's clock (after the get-ready countdown). */
  begin(participantId: string, now?: number): void {
    const me = this.requireParticipant(participantId);
    if (me.status !== "ready") throw new ArenaError("NOT_READY", "your race has already started");
    me.status = "racing";
    me.startedAt = now ?? Date.now();
  }

  // --- play ---------------------------------------------------------------
  /**
   * Guess your OWN target. Server-authoritative: requires the arena open and your
   * race running, validates and scores the guess against your own secret, counts
   * it, and on a crack locks in your finish (guessCount + own-start elapsed).
   * Returns the score — NEVER the secret.
   */
  guess(participantId: string, value: string, now?: number): DeadWoundedResult {
    if (this.status !== "open") throw new ArenaError("CLOSED", "the arena is closed");
    const me = this.requireParticipant(participantId);
    if (me.status === "ready") throw new ArenaError("NOT_STARTED", "your race has not started yet");
    if (me.status === "finished") throw new ArenaError("ALREADY_FINISHED", "you have already finished");
    if (!validate(value, this.difficultyLength)) {
      throw new ArenaError("INVALID_GUESS", `guess must be ${this.difficultyLength} distinct digits 0-9`);
    }
    me.guessCount += 1;
    const result = score(value, me.secret as string);
    if (isWin(result, this.difficultyLength)) {
      me.status = "finished";
      me.elapsedMs = me.startedAt ? Math.max(0, (now ?? Date.now()) - me.startedAt) : 0;
      me.secret = null; // retention: clear the secret once cracked (§10)
    }
    return result;
  }

  /** Admin closes the arena: no further entries or guesses; secrets cleared. */
  close(): void {
    if (this.status === "closed") throw new ArenaError("CLOSED", "the arena is already closed");
    this.status = "closed";
    for (const p of this.participants) p.secret = null;
  }

  // --- views (redacted) ---------------------------------------------------
  /** Ranked finishers (the cross-school leaderboard). */
  standings(): ArenaStandingView[] {
    const finished = this.participants.filter((p) => p.status === "finished");
    const ranked = computeRaceStandings(
      finished.map((p) => ({ userId: p.id, guessCount: p.guessCount, elapsedMs: p.elapsedMs ?? 0 })),
    );
    const handleById = new Map(finished.map((p) => [p.id, p.handle]));
    return ranked.map((r) => ({
      participantId: r.userId,
      handle: handleById.get(r.userId) ?? "",
      rank: r.rank,
      guessCount: r.guessCount,
      elapsedMs: r.elapsedMs,
    }));
  }

  /**
   * Client-safe view. SECURITY (§9): no secret appears. The leaderboard carries
   * only handles + scores; the viewer additionally sees their own entry/progress.
   */
  viewFor(participantId: string | null = null): ArenaView {
    const me = participantId ? this.participants.find((p) => p.id === participantId) ?? null : null;
    const leaderboard = this.standings();
    const myRank = me ? leaderboard.find((r) => r.participantId === me.id)?.rank ?? null : null;
    return {
      id: this.id,
      difficultyLength: this.difficultyLength,
      status: this.status,
      participantCount: this.participants.length,
      you: me?.id ?? null,
      yourEntry: me
        ? {
            participantId: me.id,
            handle: me.handle,
            status: me.status,
            guessCount: me.guessCount,
            elapsedMs: me.elapsedMs,
            rank: myRank,
          }
        : null,
      leaderboard,
    };
  }

  /** Per-finisher results for persistence (spec §10). */
  results(): ArenaResult[] {
    return this.standings().map((r) => ({
      participantId: r.participantId,
      handle: r.handle,
      rank: r.rank,
      guessCount: r.guessCount,
      elapsedMs: r.elapsedMs,
    }));
  }

  // --- internals ----------------------------------------------------------
  private requireParticipant(participantId: string): ParticipantState {
    const p = this.participants.find((x) => x.id === participantId);
    if (!p) throw new ArenaError("NOT_A_PARTICIPANT", "you have not entered this arena");
    return p;
  }
}
