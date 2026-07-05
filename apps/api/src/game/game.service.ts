// =============================================================================
// GameService — SMS-integrated 2-player Dead & Wounded (platform spec §10, step 3)
// =============================================================================
// Brings the proven engine (@sms/game-engine pure functions) into the SMS with
// the FULL security model:
//   - Tenant isolation: every row carries schoolId from the verified JWT (never
//     from the request); RLS backstops. Students only ever touch games in their
//     own school. Cross-tenant access -> 404 (never 403), no existence leak.
//   - Relationship scoping: a caller can only act on a game they are a
//     PARTICIPANT in (beyond the coarse `game.play` permission).
//   - Server authority (§9): secrets live server-side only (GamePlayer.secret),
//     are NEVER returned to any client, and are cleared once the game finishes.
//     Scoring, turn order and win detection are computed here via the engine.
//   - Every mutation is audit-logged (Golden Rule #5 — minors' game telemetry).
//
// Live turn timers / sockets are out of scope here (that is the in-memory
// transport, step 2); this is the durable, stateless, request-driven core.
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
import type { DeadWoundedDto, GameDto, GamePlayerDto, OpenGameDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { CompetitionService } from "./competition.service";
import { GameEventsService } from "./game-events.service";

@Injectable()
export class GameService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    // Post-match hook for competition matches (one-way dep; see GameModule).
    private readonly competitions: CompetitionService,
    // In-process "game changed" pub/sub — the live socket gateway re-reads the
    // RLS-scoped, viewer-redacted view on each nudge. Emitted AFTER the tx commits
    // so a subscriber that re-reads always observes the persisted state (§10).
    private readonly events: GameEventsService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- create / discover --------------------------------------------------
  /** Open a new 2-player duel; the creator is seated as the first player. */
  async createGame(p: Principal, input: { difficultyLength?: number }): Promise<GameDto> {
    const view = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const settings = effectiveGameSettings(
        await tx.gameSettings.findFirst({ where: { schoolId: p.schoolId } }),
      );
      if (!settings.gamesEnabled) {
        throw new ForbiddenException("Games are disabled for your school");
      }
      const difficultyLength = input.difficultyLength ?? settings.defaultDifficulty;
      if (!isDifficultyLength(difficultyLength)) {
        throw new BadRequestException("difficultyLength must be 4, 5, or 6");
      }
      const game = await tx.game.create({
        data: {
          schoolId: p.schoolId,
          mode: "DUEL",
          difficultyLength,
          status: "LOBBY",
          createdById: p.userId,
        },
      });
      await tx.gamePlayer.create({
        data: { schoolId: p.schoolId, gameId: game.id, userId: p.userId },
      });
      await this.log(tx, p, "game.create", "game", game.id, { difficultyLength });
      return this.buildGameView(tx, game.id, p.userId);
    });
    this.events.emitChanged(view.id);
    return view;
  }

  /** Lobbies in the caller's school still waiting for a second player. */
  async listOpenGames(p: Principal): Promise<OpenGameDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const games = await tx.game.findMany({
        where: { status: "LOBBY", mode: "DUEL" },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      const out: OpenGameDto[] = [];
      for (const g of games) {
        const players = await tx.gamePlayer.findMany({
          where: { gameId: g.id },
          select: { userId: true },
        });
        // Open = exactly one player, and the caller isn't already in it.
        if (players.length !== 1) continue;
        const host = players[0] as { userId: string };
        if (host.userId === p.userId) continue;
        out.push({
          id: g.id,
          difficultyLength: g.difficultyLength,
          createdAt: g.createdAt,
          hostDisplayName: await this.displayName(tx, host.userId),
        });
      }
      return out;
    });
  }

  // --- join / setup -------------------------------------------------------
  async joinGame(p: Principal, gameId: string): Promise<GameDto> {
    const view = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const game = await this.requireGame(tx, gameId);
      if (game.status !== "LOBBY") throw new ConflictException("Game is not open to join");
      const players = await tx.gamePlayer.findMany({ where: { gameId }, select: { userId: true } });
      if (players.length >= 2) throw new ConflictException("Game is full");
      if (players.some((pl) => pl.userId === p.userId)) {
        throw new ConflictException("You are already in this game");
      }
      // CLAIM the second seat atomically: the LOBBY→SETUP flip is guarded, so of
      // two concurrent joiners exactly ONE wins and the other 409s — a 2-player
      // duel can never over-fill to 3 seats (the count above is only a friendly
      // pre-check). A later failure in this tx rolls the flip back.
      const claimed = await tx.game.updateMany({
        where: { id: gameId, status: "LOBBY" },
        data: { status: "SETUP" },
      });
      if (claimed.count === 0) throw new ConflictException("Game is not open to join");
      await tx.gamePlayer.create({
        data: { schoolId: p.schoolId, gameId, userId: p.userId },
      });
      await this.log(tx, p, "game.join", "game", gameId);
      return this.buildGameView(tx, gameId, p.userId);
    });
    this.events.emitChanged(gameId);
    return view;
  }

  /** Submit the caller's secret. Both secrets present → the game activates. */
  async submitSecret(p: Principal, gameId: string, secret: string): Promise<GameDto> {
    let competitionId: string | null = null;
    const view = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const game = await this.requireGame(tx, gameId);
      competitionId = game.competitionId; // a league match SETUP→ACTIVE shows in standings
      const me = await this.requireSeat(tx, gameId, p.userId);
      if (game.status !== "SETUP") throw new ConflictException("Game is not awaiting secrets");
      if (!validate(secret, game.difficultyLength)) {
        throw new BadRequestException(`secret must be ${game.difficultyLength} distinct digits 0-9`);
      }
      if (me.secret !== null) throw new ConflictException("Secret already submitted");

      // SECURITY: the secret is written server-side only and never read back into
      // any client response (see buildGameView).
      await tx.gamePlayer.update({ where: { id: me.id }, data: { secret } });
      await this.log(tx, p, "game.secret.submit", "game", gameId);

      const players = await tx.gamePlayer.findMany({ where: { gameId } });
      if (players.length === 2 && players.every((pl) => pl.secret !== null)) {
        await this.activate(tx, gameId, players);
      }
      return this.buildGameView(tx, gameId, p.userId);
    });
    this.emitGameAndCompetition(gameId, competitionId);
    return view;
  }

  // --- play ---------------------------------------------------------------
  /**
   * Take a turn: guess the opponent's secret. Returns ONLY the score
   * ({ dead, wounded }) — never a secret. Server-authoritative: enforces the
   * active state and the caller's turn, scores via the engine, persists the
   * guess, and finishes the game on a crack.
   */
  async guess(p: Principal, gameId: string, value: string): Promise<DeadWoundedDto> {
    let finishedCompetitionId: string | null = null;
    const result = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const game = await this.requireGame(tx, gameId);
      const me = await this.requireSeat(tx, gameId, p.userId);
      if (game.status !== "ACTIVE") throw new ConflictException("Game is not in play");
      if (game.currentTurnPlayerId !== me.id) throw new ConflictException("It is not your turn");
      if (!validate(value, game.difficultyLength)) {
        throw new BadRequestException(`guess must be ${game.difficultyLength} distinct digits 0-9`);
      }
      const opponent = await this.opponent(tx, gameId, me.id);
      // CLAIM the turn atomically BEFORE recording anything: the guarded swap
      // matches only while it is still my turn, so a double-click / client retry
      // can never record two guesses in one turn (guessCount is the league
      // tiebreaker — silent inflation would corrupt fairness) or double-finish.
      const turnClaimed = await tx.game.updateMany({
        where: { id: gameId, status: "ACTIVE", currentTurnPlayerId: me.id },
        data: { currentTurnPlayerId: opponent.id },
      });
      if (turnClaimed.count === 0) throw new ConflictException("It is not your turn");
      // opponent.secret is guaranteed set (game is ACTIVE). Score server-side.
      const result = score(value, opponent.secret as string);

      await tx.guess.create({
        data: {
          schoolId: p.schoolId,
          gameId,
          guesserId: me.id,
          targetId: opponent.id,
          value,
          dead: result.dead,
          wounded: result.wounded,
        },
      });
      await this.log(tx, p, "game.guess", "game", gameId, {
        dead: result.dead,
        wounded: result.wounded,
      });

      if (isWin(result, game.difficultyLength)) {
        await this.finish(tx, gameId, me.id);
        // Competition match resolved → update standings / advance the bracket.
        if (game.competitionId) {
          await this.competitions.afterMatchFinished(tx, gameId);
          finishedCompetitionId = game.competitionId; // nudge the league only on resolve
        }
      }
      // (no else: the turn already advanced in the atomic claim above; the win
      // path's finish() overwrites turn/status to the terminal state anyway)
      return { dead: result.dead, wounded: result.wounded };
    });
    this.emitGameAndCompetition(gameId, finishedCompetitionId);
    return result;
  }

  /** Abandon the game; the opponent wins by forfeit. */
  async forfeit(p: Principal, gameId: string): Promise<GameDto> {
    let competitionId: string | null = null;
    const view = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const game = await this.requireGame(tx, gameId);
      const me = await this.requireSeat(tx, gameId, p.userId);
      if (game.status !== "ACTIVE" && game.status !== "SETUP") {
        throw new ConflictException("Game is not running");
      }
      const opponent = await this.opponent(tx, gameId, me.id);
      await this.finish(tx, gameId, opponent.id, "FORFEIT", me.id);
      // Competition match resolved → update standings / advance the bracket.
      if (game.competitionId) {
        await this.competitions.afterMatchFinished(tx, gameId);
        competitionId = game.competitionId;
      }
      await this.log(tx, p, "game.forfeit", "game", gameId);
      return this.buildGameView(tx, gameId, p.userId);
    });
    this.emitGameAndCompetition(gameId, competitionId);
    return view;
  }

  // --- read ---------------------------------------------------------------
  /** A participant's redacted view of their game (no secrets while live). */
  async getGame(p: Principal, gameId: string): Promise<GameDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireGame(tx, gameId);
      await this.requireSeat(tx, gameId, p.userId); // relationship scope → 404 if not a player
      return this.buildGameView(tx, gameId, p.userId);
    });
  }

  // --- internals ----------------------------------------------------------
  private async activate(
    tx: TenantTx,
    gameId: string,
    players: Array<{ id: string }>,
  ): Promise<void> {
    const [a, b] = players as [{ id: string }, { id: string }];
    // SECURITY: random first mover — going first is a coin flip, decided server-side.
    const first = Math.random() < 0.5 ? a : b;
    await tx.gamePlayer.update({ where: { id: a.id }, data: { targetId: b.id } });
    await tx.gamePlayer.update({ where: { id: b.id }, data: { targetId: a.id } });
    await tx.game.update({
      where: { id: gameId },
      data: { status: "ACTIVE", startedAt: new Date(), currentTurnPlayerId: first.id },
    });
  }

  private async finish(
    tx: TenantTx,
    gameId: string,
    winnerPlayerId: string,
    loserOutcome: "LOST" | "FORFEIT" = "LOST",
    forfeiterPlayerId?: string,
  ): Promise<void> {
    const players = await tx.gamePlayer.findMany({ where: { gameId } });
    for (const pl of players) {
      const won = pl.id === winnerPlayerId;
      const guessCount = await tx.guess.count({ where: { gameId, guesserId: pl.id } });
      const outcome = won ? "WON" : forfeiterPlayerId === pl.id ? loserOutcome : "LOST";
      await tx.gameResult.create({
        data: {
          schoolId: pl.schoolId,
          gameId,
          userId: pl.userId,
          rank: won ? 1 : 2,
          guessCount,
          outcome,
        },
      });
    }
    // Retention: clear secrets once the game is over — they are not kept (§10).
    await tx.gamePlayer.updateMany({ where: { gameId }, data: { secret: null } });
    await tx.game.update({
      where: { id: gameId },
      data: {
        status: "FINISHED",
        winnerPlayerId,
        currentTurnPlayerId: null,
        finishedAt: new Date(),
      },
    });
  }

  private async requireGame(tx: TenantTx, gameId: string) {
    // RLS already scopes to the caller's school; a miss here means "not in my
    // school or doesn't exist" → 404, never revealing cross-tenant existence.
    const game = await tx.game.findFirst({ where: { id: gameId } });
    if (!game) throw new NotFoundException("Game not found");
    return game;
  }

  private async requireSeat(tx: TenantTx, gameId: string, userId: string) {
    const me = await tx.gamePlayer.findFirst({ where: { gameId, userId } });
    if (!me) throw new NotFoundException("Game not found"); // relationship scope, not 403
    return me;
  }

  private async opponent(tx: TenantTx, gameId: string, myPlayerId: string) {
    const opp = await tx.gamePlayer.findFirst({ where: { gameId, id: { not: myPlayerId } } });
    if (!opp) throw new ConflictException("Opponent not present");
    return opp;
  }

  private async displayName(tx: TenantTx, userId: string): Promise<string> {
    const u = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
    return u?.name ?? "Player";
  }

  /**
   * Build the client-facing game view. CRITICAL: `secret` is read server-side
   * (to compute `ready` and for scoring) but is NEVER placed in the output.
   */
  private async buildGameView(tx: TenantTx, gameId: string, viewerUserId: string): Promise<GameDto> {
    const game = await this.requireGame(tx, gameId);
    const players = await tx.gamePlayer.findMany({
      where: { gameId },
      orderBy: { joinedAt: "asc" },
    });
    const guesses = await tx.guess.findMany({
      where: { gameId },
      orderBy: { createdAt: "asc" },
    });

    const playerViews: GamePlayerDto[] = [];
    let you: string | null = null;
    for (const pl of players) {
      if (pl.userId === viewerUserId) you = pl.id;
      const guessCount = guesses.filter((g) => g.guesserId === pl.id).length;
      playerViews.push({
        playerId: pl.id,
        userId: pl.userId,
        displayName: await this.displayName(tx, pl.userId),
        ready: pl.secret !== null, // computed from the secret, but the secret is NOT exposed
        eliminated: pl.eliminated,
        guessCount,
      });
    }

    return {
      id: game.id,
      mode: game.mode,
      difficultyLength: game.difficultyLength,
      status: game.status,
      currentTurnPlayerId: game.currentTurnPlayerId,
      winnerPlayerId: game.winnerPlayerId,
      you,
      createdAt: game.createdAt,
      startedAt: game.startedAt,
      finishedAt: game.finishedAt,
      players: playerViews,
      guesses: guesses.map((g) => ({
        id: g.id,
        guesserId: g.guesserId,
        targetId: g.targetId,
        value: g.value,
        dead: g.dead,
        wounded: g.wounded,
        createdAt: g.createdAt,
      })),
    };
  }

  private async log(
    tx: TenantTx,
    p: Principal,
    action: string,
    entity: string,
    entityId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      { actorId: p.userId, action, entity, entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }

  /**
   * Announce a committed change to a game AND, when it belongs to a competition,
   * to the competition itself — so a league/knockout watcher (keyed by the
   * competitionId) re-reads its standings/bracket. Both ids ride the one event
   * bus; the bus is just a gameId nudge with no authority (§10).
   */
  private emitGameAndCompetition(gameId: string, competitionId: string | null): void {
    this.events.emitChanged(gameId);
    if (competitionId) this.events.emitChanged(competitionId);
  }
}
