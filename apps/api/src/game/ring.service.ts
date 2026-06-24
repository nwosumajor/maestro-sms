// =============================================================================
// RingService — SMS Elimination Ring (platform spec §4, build step 6)
// =============================================================================
// Category 1: N players in a ring, each targeting the next (P1→P2→…→Pn→P1). On
// your turn you guess your CURRENT target's secret; crack it and that player is
// eliminated, the ring RE-CLOSES (you inherit their target — spec §4), and you
// gain read access to the eliminated player's session guess history (the §4
// reward — session-scoped, nobody else's data). Last player standing wins.
//
// Reuses the duel tables (Game mode RING / GamePlayer / Guess / GameResult) — no
// new tables, so RLS is the existing game policies. A RING is turn-based and
// owns its whole lifecycle here (it does NOT route through GameService).
//
// Server authority (spec §9): secrets are server-only (GamePlayer.secret), NEVER
// serialized and cleared on finish; scoring, turn order, the ring re-close, and
// win detection are computed here; clients are display-only. Turn order is
// enforced server-side (a player cannot guess out of turn). The 60s turn limit is
// validated server-side from Game.turnStartedAt: a graduated rule skips the first
// two timeouts and forfeits on the third (spec §4). Live sockets / the 15s
// countdown warning / hard-disconnect detection belong to the real-time transport
// (step 2) and are out of this durable, request-driven core, exactly as the duel.
//
// Tenant isolation + relationship scoping (participant-only, 404-not-403) +
// audited mutations follow the standard built-module pattern (CLAUDE.md).
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isDifficultyLength, isWin, score, validate } from "@sms/game-engine";
import { effectiveGameSettings } from "./game-settings.util";
import type {
  InheritedHistoryDto,
  RingDto,
  RingGuessDto,
  RingPlayerDto,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal", "super_admin"]);
/** Graduated timeout rule (spec §4): skip the first two, forfeit on the third. */
const MAX_TIMEOUTS = 3;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;

@Injectable()
export class RingService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isSchoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  // --- lobby / setup ------------------------------------------------------
  /** Open a ring; the creator is seated as the first player. */
  async openRing(p: Principal, input: { difficultyLength?: number }): Promise<RingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const settings = await this.settings(tx, p.schoolId);
      if (!settings.gamesEnabled) {
        throw new ForbiddenException("Games are disabled for your school");
      }
      const difficultyLength = input.difficultyLength ?? settings.defaultDifficulty;
      if (!isDifficultyLength(difficultyLength)) {
        throw new BadRequestException("difficultyLength must be 4, 5, or 6");
      }
      const ring = await tx.game.create({
        data: {
          schoolId: p.schoolId,
          mode: "RING",
          difficultyLength,
          status: "LOBBY",
          createdById: p.userId,
        },
      });
      await tx.gamePlayer.create({ data: { schoolId: p.schoolId, gameId: ring.id, userId: p.userId } });
      await this.log(tx, p, "ring.open", ring.id, { difficultyLength });
      return this.buildRingView(tx, ring.id, p.userId);
    });
  }

  async joinRing(p: Principal, ringId: string): Promise<RingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const ring = await this.requireRing(tx, ringId);
      if (ring.status !== "LOBBY") throw new ConflictException("Ring is not open to join");
      const players = await tx.gamePlayer.findMany({ where: { gameId: ringId }, select: { userId: true } });
      if (players.length >= MAX_PLAYERS) throw new ConflictException("Ring is full");
      if (players.some((pl) => pl.userId === p.userId)) {
        throw new ConflictException("You are already in this ring");
      }
      await tx.gamePlayer.create({ data: { schoolId: p.schoolId, gameId: ringId, userId: p.userId } });
      await this.log(tx, p, "ring.join", ringId);
      return this.buildRingView(tx, ringId, p.userId);
    });
  }

  /** Creator locks the roster and moves to secret submission (needs ≥3). */
  async startRing(p: Principal, ringId: string): Promise<RingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const ring = await this.requireRing(tx, ringId);
      if (ring.createdById !== p.userId) throw new NotFoundException("Ring not found");
      if (ring.status !== "LOBBY") throw new ConflictException("Ring is not in the lobby");
      const count = await tx.gamePlayer.count({ where: { gameId: ringId } });
      if (count < MIN_PLAYERS) {
        throw new BadRequestException(`a ring needs at least ${MIN_PLAYERS} players`);
      }
      await tx.game.update({ where: { id: ringId }, data: { status: "SETUP" } });
      await this.log(tx, p, "ring.start", ringId, { players: count });
      return this.buildRingView(tx, ringId, p.userId);
    });
  }

  /** Submit the caller's secret. All secrets in → the ring activates. */
  async submitSecret(p: Principal, ringId: string, secret: string): Promise<RingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const ring = await this.requireRing(tx, ringId);
      const me = await this.requireParticipant(tx, ringId, p.userId);
      if (ring.status !== "SETUP") throw new ConflictException("Ring is not awaiting secrets");
      if (!validate(secret, ring.difficultyLength)) {
        throw new BadRequestException(`secret must be ${ring.difficultyLength} distinct digits 0-9`);
      }
      if (me.secret !== null) throw new ConflictException("Secret already submitted");
      // SECURITY: written server-side only; never read back into any response.
      await tx.gamePlayer.update({ where: { id: me.id }, data: { secret } });
      await this.log(tx, p, "ring.secret.submit", ringId);

      const players = await tx.gamePlayer.findMany({ where: { gameId: ringId } });
      if (players.every((pl) => pl.secret !== null)) {
        await this.activate(tx, ringId, players);
      }
      return this.buildRingView(tx, ringId, p.userId);
    });
  }

  // --- play ---------------------------------------------------------------
  /**
   * Take your turn: guess your CURRENT target's secret. Returns ONLY your score
   * ({ dead, wounded }). Server-authoritative: enforces ACTIVE state + your turn,
   * scores via the engine, persists the guess, and on a crack eliminates the
   * target, re-closes the ring (you inherit their target), and advances play.
   */
  async guess(
    p: Principal,
    ringId: string,
    value: string,
  ): Promise<{ dead: number; wounded: number }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const ring = await this.requireRing(tx, ringId);
      const me = await this.requireParticipant(tx, ringId, p.userId);
      if (ring.status !== "ACTIVE") throw new ConflictException("Ring is not in play");
      if (me.eliminated) throw new ConflictException("You have been eliminated");
      if (ring.currentTurnPlayerId !== me.id) throw new ConflictException("It is not your turn");
      if (!validate(value, ring.difficultyLength)) {
        throw new BadRequestException(`guess must be ${ring.difficultyLength} distinct digits 0-9`);
      }
      const target = me.targetId
        ? await tx.gamePlayer.findFirst({ where: { id: me.targetId } })
        : null;
      if (!target || target.eliminated || target.secret === null) {
        throw new ConflictException("No valid target");
      }
      const result = score(value, target.secret);
      await tx.guess.create({
        data: {
          schoolId: p.schoolId,
          gameId: ringId,
          guesserId: me.id,
          targetId: target.id,
          value,
          dead: result.dead,
          wounded: result.wounded,
        },
      });
      // Showing up resets the timeout counter (it tracks consecutive timeouts).
      await tx.gamePlayer.update({ where: { id: me.id }, data: { consecutiveMisses: 0 } });
      await this.log(tx, p, "ring.guess", ringId, { dead: result.dead, wounded: result.wounded });

      if (isWin(result, ring.difficultyLength)) {
        const finished = await this.eliminate(tx, ring, target.id, me.id, "ELIMINATED");
        if (!finished) await this.advanceTurn(tx, ringId, me.id); // me now targets the re-closed next
      } else {
        await this.advanceTurn(tx, ringId, me.id);
      }
      return { dead: result.dead, wounded: result.wounded };
    });
  }

  /**
   * Advance an EXPIRED turn (the 60s window has closed). Server-validated from
   * turnStartedAt so it can't be abused. Graduated: misses 1–2 skip the turn;
   * miss 3 forfeits the stalling player (spec §4). Any participant may nudge.
   */
  async timeoutTurn(p: Principal, ringId: string): Promise<RingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const ring = await this.requireRing(tx, ringId);
      await this.requireParticipant(tx, ringId, p.userId);
      if (ring.status !== "ACTIVE") throw new ConflictException("Ring is not in play");
      if (!ring.currentTurnPlayerId || !ring.turnStartedAt) {
        throw new ConflictException("No active turn");
      }
      const turnLimitMs = (await this.settings(tx, p.schoolId)).ringTurnLimitSec * 1000;
      if (Date.now() - ring.turnStartedAt.getTime() < turnLimitMs) {
        throw new ConflictException("The current turn has not expired");
      }
      const current = await tx.gamePlayer.findFirst({ where: { id: ring.currentTurnPlayerId } });
      if (!current) throw new ConflictException("No active turn");
      const misses = current.consecutiveMisses + 1;
      await tx.gamePlayer.update({ where: { id: current.id }, data: { consecutiveMisses: misses } });

      if (misses >= MAX_TIMEOUTS) {
        const finished = await this.eliminate(tx, ring, current.id, null, "FORFEIT");
        if (!finished) await this.advanceTurn(tx, ringId, current.id); // to current's successor
        await this.log(tx, p, "ring.timeout.forfeit", ringId, { player: current.id });
      } else {
        await this.advanceTurn(tx, ringId, current.id); // skip; player stays in the ring
        await this.log(tx, p, "ring.timeout.skip", ringId, { player: current.id, misses });
      }
      return this.buildRingView(tx, ringId, p.userId);
    });
  }

  /** Voluntarily quit an active ring; the ring re-closes around you. */
  async forfeit(p: Principal, ringId: string): Promise<RingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const ring = await this.requireRing(tx, ringId);
      const me = await this.requireParticipant(tx, ringId, p.userId);
      if (ring.status !== "ACTIVE") throw new ConflictException("Ring is not in play");
      if (me.eliminated) throw new ConflictException("You have been eliminated");
      const finished = await this.eliminate(tx, ring, me.id, null, "FORFEIT");
      if (!finished && ring.currentTurnPlayerId === me.id) {
        await this.advanceTurn(tx, ringId, me.id);
      }
      await this.log(tx, p, "ring.forfeit", ringId);
      return this.buildRingView(tx, ringId, p.userId);
    });
  }

  /** Moderator force-ends a ring (abandoned / stuck). No winner is declared. */
  async endRing(p: Principal, ringId: string): Promise<RingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const ring = await this.requireRing(tx, ringId);
      if (ring.status === "FINISHED" || ring.status === "ABANDONED") {
        throw new ConflictException("Ring is already over");
      }
      // Retention: clear all secrets on close (server-only, §10).
      await tx.gamePlayer.updateMany({ where: { gameId: ringId }, data: { secret: null } });
      await tx.game.update({
        where: { id: ringId },
        data: { status: "ABANDONED", currentTurnPlayerId: null, turnStartedAt: null, finishedAt: new Date() },
      });
      await this.log(tx, p, "ring.end", ringId);
      return this.buildRingView(tx, ringId, p.userId);
    });
  }

  // --- read ---------------------------------------------------------------
  async getRing(p: Principal, ringId: string): Promise<RingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireRing(tx, ringId); // 404 if absent / cross-tenant
      if (!this.isSchoolWide(p)) {
        const seat = await tx.gamePlayer.findFirst({ where: { gameId: ringId, userId: p.userId } });
        if (!seat) throw new NotFoundException("Ring not found"); // relationship scope
      }
      return this.buildRingView(tx, ringId, p.userId);
    });
  }

  // =========================================================================
  // internals
  // =========================================================================
  /** Form the ring: order by join time, each targets the next, P0 starts. */
  private async activate(
    tx: TenantTx,
    ringId: string,
    players: Array<{ id: string; joinedAt: Date }>,
  ): Promise<void> {
    const ordered = [...players].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
    for (let i = 0; i < ordered.length; i++) {
      const me = ordered[i] as { id: string };
      const next = ordered[(i + 1) % ordered.length] as { id: string };
      await tx.gamePlayer.update({ where: { id: me.id }, data: { targetId: next.id } });
    }
    await tx.game.update({
      where: { id: ringId },
      data: {
        status: "ACTIVE",
        startedAt: new Date(),
        currentTurnPlayerId: (ordered[0] as { id: string }).id,
        turnStartedAt: new Date(),
      },
    });
  }

  /**
   * Eliminate `victimId`, re-close the ring (their predecessor inherits their
   * target), and record the placing. Returns true if this ended the ring.
   */
  private async eliminate(
    tx: TenantTx,
    ring: { id: string; schoolId: string },
    victimId: string,
    byPlayerId: string | null,
    outcome: "ELIMINATED" | "FORFEIT",
  ): Promise<boolean> {
    const active = await tx.gamePlayer.findMany({ where: { gameId: ring.id, eliminated: false } });
    const victim = active.find((pl) => pl.id === victimId);
    if (!victim) return false;
    // Ring re-close: whoever targeted the victim now targets the victim's target.
    const predecessor = active.find((pl) => pl.targetId === victimId && pl.id !== victimId);
    if (predecessor && victim.targetId) {
      await tx.gamePlayer.update({ where: { id: predecessor.id }, data: { targetId: victim.targetId } });
    }
    await tx.gamePlayer.update({
      where: { id: victimId },
      data: { eliminated: true, eliminatedById: byPlayerId },
    });

    const remaining = active.length - 1;
    const guessCount = await tx.guess.count({ where: { gameId: ring.id, guesserId: victimId } });
    // Placing: first out finishes last; the runner-up is rank 2 (spec §4 last-one-
    // standing). remaining players AFTER this elimination → this player's rank.
    await tx.gameResult.create({
      data: { schoolId: ring.schoolId, gameId: ring.id, userId: victim.userId, rank: remaining + 1, guessCount, outcome },
    });

    if (remaining <= 1) {
      const winner = active.find((pl) => pl.id !== victimId);
      if (winner) await this.finishRing(tx, ring, winner);
      return true;
    }
    return false;
  }

  private async finishRing(
    tx: TenantTx,
    ring: { id: string; schoolId: string },
    winner: { id: string; userId: string },
  ): Promise<void> {
    const guessCount = await tx.guess.count({ where: { gameId: ring.id, guesserId: winner.id } });
    await tx.gameResult.create({
      data: { schoolId: ring.schoolId, gameId: ring.id, userId: winner.userId, rank: 1, guessCount, outcome: "WON" },
    });
    // Retention: clear all secrets once the ring is over (§10).
    await tx.gamePlayer.updateMany({ where: { gameId: ring.id }, data: { secret: null } });
    await tx.game.update({
      where: { id: ring.id },
      data: {
        status: "FINISHED",
        winnerPlayerId: winner.id,
        currentTurnPlayerId: null,
        turnStartedAt: null,
        finishedAt: new Date(),
      },
    });
  }

  /** Pass the turn to whoever `fromPlayerId` now targets (the next active player
   *  around the re-closed ring), and (re)start the turn clock. */
  private async advanceTurn(tx: TenantTx, ringId: string, fromPlayerId: string): Promise<void> {
    const from = await tx.gamePlayer.findFirst({ where: { id: fromPlayerId } });
    if (!from?.targetId) return;
    await tx.game.update({
      where: { id: ringId },
      data: { currentTurnPlayerId: from.targetId, turnStartedAt: new Date() },
    });
  }

  private async requireRing(tx: TenantTx, ringId: string) {
    const ring = await tx.game.findFirst({ where: { id: ringId, mode: "RING" } });
    if (!ring) throw new NotFoundException("Ring not found"); // RLS-scoped → 404 cross-tenant
    return ring;
  }

  private async requireParticipant(tx: TenantTx, ringId: string, userId: string) {
    const me = await tx.gamePlayer.findFirst({ where: { gameId: ringId, userId } });
    if (!me) throw new NotFoundException("Ring not found"); // relationship scope, not 403
    return me;
  }

  private async displayName(tx: TenantTx, userId: string): Promise<string> {
    const u = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
    return u?.name ?? "Player";
  }

  /** The school's effective game settings (row merged over platform defaults). */
  private async settings(tx: TenantTx, schoolId: string) {
    return effectiveGameSettings(await tx.gameSettings.findFirst({ where: { schoolId } }));
  }

  /**
   * Build the viewer-redacted ring view. SECURITY: no secret is exposed; the
   * viewer gets ONLY their own guesses plus the inherited histories of players
   * THEY eliminated (§4). Other live players' guesses are never serialized.
   */
  private async buildRingView(tx: TenantTx, ringId: string, viewerUserId: string): Promise<RingDto> {
    const ring = await this.requireRing(tx, ringId);
    const players = await tx.gamePlayer.findMany({ where: { gameId: ringId }, orderBy: { joinedAt: "asc" } });
    const results = await tx.gameResult.findMany({ where: { gameId: ringId } });
    const guesses = await tx.guess.findMany({ where: { gameId: ringId }, orderBy: { createdAt: "asc" } });
    const me = players.find((pl) => pl.userId === viewerUserId) ?? null;

    const rankByUser = new Map(results.map((r) => [r.userId, r.rank]));
    const playerDtos: RingPlayerDto[] = [];
    for (const pl of players) {
      playerDtos.push({
        playerId: pl.id,
        userId: pl.userId,
        displayName: await this.displayName(tx, pl.userId),
        ready: pl.secret !== null,
        eliminated: pl.eliminated,
        rank: rankByUser.get(pl.userId) ?? null,
        guessCount: guesses.filter((g) => g.guesserId === pl.id).length,
      });
    }

    const toGuessDto = (g: (typeof guesses)[number]): RingGuessDto => ({
      guesserId: g.guesserId,
      targetId: g.targetId,
      value: g.value,
      dead: g.dead,
      wounded: g.wounded,
      createdAt: g.createdAt,
    });
    const yourGuesses = me ? guesses.filter((g) => g.guesserId === me.id).map(toGuessDto) : [];

    const inheritedHistories: InheritedHistoryDto[] = [];
    if (me) {
      for (const pl of players) {
        if (pl.eliminatedById === me.id) {
          inheritedHistories.push({
            fromPlayerId: pl.id,
            fromDisplayName: await this.displayName(tx, pl.userId),
            guesses: guesses.filter((g) => g.guesserId === pl.id).map(toGuessDto),
          });
        }
      }
    }

    const turnLimitMs = (await this.settings(tx, ring.schoolId)).ringTurnLimitSec * 1000;
    const turnExpiresAt = ring.turnStartedAt
      ? new Date(ring.turnStartedAt.getTime() + turnLimitMs)
      : null;

    return {
      id: ring.id,
      difficultyLength: ring.difficultyLength,
      status: ring.status as RingDto["status"],
      currentTurnPlayerId: ring.currentTurnPlayerId,
      turnStartedAt: ring.turnStartedAt,
      turnExpiresAt,
      winnerPlayerId: ring.winnerPlayerId,
      you: me?.id ?? null,
      yourTargetPlayerId: me && !me.eliminated && ring.status === "ACTIVE" ? me.targetId : null,
      createdAt: ring.createdAt,
      startedAt: ring.startedAt,
      finishedAt: ring.finishedAt,
      players: playerDtos,
      yourGuesses,
      inheritedHistories,
    };
  }

  private async log(
    tx: TenantTx,
    p: Principal,
    action: string,
    entityId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      { actorId: p.userId, action, entity: "ring", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
