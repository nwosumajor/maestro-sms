// =============================================================================
// HangmanService — classroom letter-guessing game (SMS integration)
// =============================================================================
// A teacher HOSTS a round for a class around ONE server-only word; enrolled
// students each play their OWN board of that word in PARALLEL, and whoever solves
// with the fewest wrong guesses (then earliest) wins. Rules run in the pure
// engine (@sms/game-engine hangman.ts) — this service reconstructs each player's
// state from (word, guessed) so the engine stays the single source of truth.
//
// Security posture (standard built-module pattern):
//   - Tenant isolation: schoolId from the JWT on every row; RLS backstops.
//   - Relationship scoping: host = teacher of the class (or school-wide staff);
//     players = ENROLLED students; a viewer only sees rounds they host/teach/are
//     enrolled in/joined. 404-not-403 cross-tenant & cross-relationship.
//   - Server authority (spec §9): the word is NEVER serialized while a round is
//     live — each player sees only their MASKED word; revealed on finish, then
//     cleared. Guess validation + scoring computed here.
//   - Every mutation is audit-logged (Golden Rule #5 — minors' game telemetry).
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  HANGMAN_DIFFICULTY_SPECS,
  guessLetter,
  isGameDifficulty,
  isValidHangmanWord,
  livesRemaining,
  maskedWord,
  newHangmanState,
  type GameDifficulty,
  type HangmanState,
} from "@sms/game-engine";
import { Prisma } from "@sms/db";
import type {
  HangmanDifficultyDto,
  HangmanGameDto,
  HangmanGuessResultDto,
  HangmanSummaryDto,
} from "@sms/types";
import { randomInt } from "node:crypto";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { effectiveGameSettings } from "./game-settings.util";
import { GameEventsService } from "./game-events.service";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal", "super_admin"]);

/** Built-in curriculum-neutral word bank, banded by difficulty word-length. A
 *  host may override with their own word (e.g. a spelling-list term). */
const WORD_BANK: Record<GameDifficulty, string[]> = {
  EASY: ["APPLE", "RIVER", "TIGER", "OCEAN", "PLANT", "HOUSE", "MUSIC", "BREAD", "CLOUD", "HORSE"],
  MEDIUM: ["VOLCANO", "GRAVITY", "HARVEST", "JOURNEY", "LIBRARY", "CAPTAIN", "DIAMOND", "PENGUIN"],
  HARD: ["PHOTOSYNTHESIS", "CONSTELLATION", "ARCHIPELAGO", "METAMORPHOSIS", "PARLIAMENTARY", "BIODIVERSITY"],
};

@Injectable()
export class HangmanService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly events: GameEventsService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isSchoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  private async withEmit<T extends { id?: string }>(
    p: Principal,
    id: string | null,
    fn: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    const out = await this.db.runAsTenant(this.ctx(p), fn);
    const gameId = id ?? out.id ?? null;
    if (gameId) this.events.emitChanged(gameId);
    return out;
  }

  // --- lifecycle ----------------------------------------------------------
  /** Host opens a round for a class. Word is server-side (bank pick or supplied). */
  async openGame(
    p: Principal,
    input: { classId: string; difficulty?: string; word?: string },
  ): Promise<HangmanGameDto> {
    return this.withEmit(p, null, async (tx) => {
      await this.assertGamesEnabled(tx, p.schoolId);
      await this.assertTeacherOfClass(tx, p, input.classId);
      const difficulty = input.difficulty && isGameDifficulty(input.difficulty) ? input.difficulty : "MEDIUM";
      // SECURITY: a host-supplied word is validated (letters only); else a random
      // bank word for the difficulty. Stored UPPER-CASE, never echoed while live.
      let word: string;
      if (input.word) {
        if (!isValidHangmanWord(input.word)) {
          throw new BadRequestException("word must be letters A-Z only (no spaces/digits)");
        }
        word = input.word.toUpperCase();
      } else {
        const bank = WORD_BANK[difficulty];
        word = bank[randomInt(0, bank.length)]!;
      }
      const game = await tx.hangmanGame.create({
        data: { schoolId: p.schoolId, classId: input.classId, hostId: p.userId, difficulty, word, status: "LOBBY" },
      });
      await this.log(tx, p, "hangman.open", game.id, { classId: input.classId, difficulty });
      return this.buildView(tx, game.id, p);
    });
  }

  async joinGame(p: Principal, gameId: string): Promise<HangmanGameDto> {
    return this.withEmit(p, gameId, async (tx) => {
      const game = await this.requireGame(tx, gameId);
      if (game.status === "FINISHED") throw new ConflictException("Round is over");
      await this.assertEnrolled(tx, p, game.classId);
      const existing = await tx.hangmanPlayer.findFirst({ where: { gameId, userId: p.userId } });
      if (!existing) {
        await tx.hangmanPlayer.create({
          data: { schoolId: p.schoolId, gameId, userId: p.userId, guessed: [] as unknown as Prisma.InputJsonValue },
        });
        await this.log(tx, p, "hangman.join", gameId);
      }
      return this.buildView(tx, gameId, p);
    });
  }

  /** Host starts the round: play opens for everyone. */
  async startGame(p: Principal, gameId: string): Promise<HangmanGameDto> {
    return this.withEmit(p, gameId, async (tx) => {
      const game = await this.requireGame(tx, gameId);
      await this.assertHost(tx, p, game);
      if (game.status !== "LOBBY") throw new ConflictException("Round is not in the lobby");
      const count = await tx.hangmanPlayer.count({ where: { gameId } });
      if (count < 1) throw new BadRequestException("no players have joined");
      await tx.hangmanGame.update({ where: { id: gameId }, data: { status: "ACTIVE", startedAt: new Date() } });
      await this.log(tx, p, "hangman.start", gameId, { players: count });
      return this.buildView(tx, gameId, p);
    });
  }

  /**
   * Guess a single letter on the caller's own board. Reconstructs the engine
   * state from (word, guessed), applies the guess, persists the projection, and
   * on a solve records the podium rank. Returns ONLY the caller's own board.
   */
  async guess(p: Principal, gameId: string, letter: string): Promise<HangmanGuessResultDto> {
    const result = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const game = await this.requireGame(tx, gameId);
      if (game.status !== "ACTIVE") throw new ConflictException("Round is not in play");
      const me = await tx.hangmanPlayer.findFirst({ where: { gameId, userId: p.userId } });
      if (!me) throw new NotFoundException("Round not found"); // relationship scope
      if (me.status !== "PLAYING") throw new ConflictException("Your board is already finished");
      const L = typeof letter === "string" ? letter.trim().toUpperCase() : "";
      if (!/^[A-Z]$/.test(L)) throw new BadRequestException("guess must be a single letter A-Z");

      const state = this.rebuild(game.word as string, game.difficulty, me.guessed as unknown as string[]);
      if (state.guessed.includes(L)) throw new ConflictException("You already guessed that letter");
      const { state: next, hit } = guessLetter(state, L);

      const solvedNow = next.status === "WON";
      let rank = me.rank;
      if (solvedNow) rank = await this.recordSolve(tx, game, p.userId);
      await tx.hangmanPlayer.update({
        where: { id: me.id },
        data: {
          guessed: next.guessed as unknown as Prisma.InputJsonValue,
          wrong: next.wrong,
          status: next.status,
          ...(solvedNow ? { solvedAt: new Date(), rank } : {}),
        },
      });
      await this.log(tx, p, "hangman.guess", gameId, { hit, status: next.status });
      await this.maybeFinish(tx, game.id);
      return {
        hit,
        masked: maskedWord(next),
        wrong: next.wrong,
        livesRemaining: livesRemaining(next),
        status: next.status as HangmanGuessResultDto["status"],
      };
    });
    this.events.emitChanged(gameId);
    return result;
  }

  /** Host ends the round early (reveals the word). */
  async endGame(p: Principal, gameId: string): Promise<HangmanGameDto> {
    return this.withEmit(p, gameId, async (tx) => {
      const game = await this.requireGame(tx, gameId);
      await this.assertHost(tx, p, game);
      if (game.status === "FINISHED") throw new ConflictException("Round is already over");
      await this.finish(tx, game.id);
      await this.log(tx, p, "hangman.end", gameId);
      return this.buildView(tx, gameId, p);
    });
  }

  // --- reads --------------------------------------------------------------
  async getGame(p: Principal, gameId: string): Promise<HangmanGameDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const game = await this.requireGame(tx, gameId);
      await this.assertCanView(tx, p, game);
      return this.buildView(tx, gameId, p);
    });
  }

  /** Joinable/active rounds the caller can see (relationship-scoped like race). */
  async listGames(p: Principal): Promise<HangmanSummaryDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      let games;
      if (this.isSchoolWide(p)) {
        games = await tx.hangmanGame.findMany({
          where: { status: { in: ["LOBBY", "ACTIVE"] } },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
      } else {
        const [taught, enrolled, joined] = await Promise.all([
          tx.classTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } }),
          tx.enrollment.findMany({ where: { studentId: p.userId }, select: { classId: true } }),
          tx.hangmanPlayer.findMany({ where: { userId: p.userId }, select: { gameId: true } }),
        ]);
        const classIds = [...new Set([...taught.map((t) => t.classId), ...enrolled.map((e) => e.classId)])];
        const gameIds = joined.map((j) => j.gameId);
        games = await tx.hangmanGame.findMany({
          where: {
            status: { in: ["LOBBY", "ACTIVE"] },
            OR: [{ classId: { in: classIds } }, { id: { in: gameIds } }, { hostId: p.userId }],
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
      }
      if (games.length === 0) return [];

      const gameIds = games.map((g) => g.id);
      const classIds = [...new Set(games.map((g) => g.classId))];
      const [counts, mine, classes] = await Promise.all([
        tx.hangmanPlayer.groupBy({ by: ["gameId"], where: { gameId: { in: gameIds } }, _count: { _all: true } }),
        tx.hangmanPlayer.findMany({ where: { gameId: { in: gameIds }, userId: p.userId }, select: { gameId: true } }),
        tx.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } }),
      ]);
      const countByGame = new Map(counts.map((c) => [c.gameId, c._count._all]));
      const joinedSet = new Set(mine.map((m) => m.gameId));
      const nameByClass = new Map(classes.map((c) => [c.id, c.name]));
      return games.map((g) => ({
        id: g.id,
        classId: g.classId,
        className: nameByClass.get(g.classId) ?? null,
        difficulty: g.difficulty as HangmanDifficultyDto,
        status: g.status as HangmanSummaryDto["status"],
        participantCount: countByGame.get(g.id) ?? 0,
        joined: joinedSet.has(g.id),
        isHost: g.hostId === p.userId,
        createdAt: g.createdAt,
      }));
    });
  }

  // =========================================================================
  // internals
  // =========================================================================
  /** Rebuild a player's engine state from the stored guess list (deterministic). */
  private rebuild(word: string, difficulty: string, guessed: string[]): HangmanState {
    const diff = (isGameDifficulty(difficulty) ? difficulty : "MEDIUM") as GameDifficulty;
    let state = newHangmanState(word, diff);
    for (const L of guessed) state = guessLetter(state, L).state;
    return state;
  }

  /** Assign the next podium rank atomically (row-lock the game like race). */
  private async recordSolve(tx: TenantTx, game: { id: string }, _userId: string): Promise<number> {
    await tx.$executeRaw`SELECT id FROM "hangman_game" WHERE id = ${game.id}::uuid FOR UPDATE`;
    const solvedSoFar = await tx.hangmanPlayer.count({ where: { gameId: game.id, status: "WON" } });
    return solvedSoFar + 1;
  }

  /** Finish the round once every player is done (WON/LOST), or on host end. */
  private async maybeFinish(tx: TenantTx, gameId: string): Promise<void> {
    const players = await tx.hangmanPlayer.findMany({ where: { gameId }, select: { status: true } });
    if (players.length > 0 && players.every((pl) => pl.status !== "PLAYING")) {
      await this.finish(tx, gameId);
    }
  }

  private async finish(tx: TenantTx, gameId: string): Promise<void> {
    const winner = await tx.hangmanPlayer.findFirst({ where: { gameId, rank: 1 }, select: { userId: true } });
    // The word is RETAINED and REVEALED on finish — unlike a race target (never
    // shown), the answer is the educational payoff of a hangman round. It stays
    // server-only WHILE LIVE and is only serialized once status is FINISHED.
    await tx.hangmanGame.update({
      where: { id: gameId },
      data: { status: "FINISHED", finishedAt: new Date(), winnerUserId: winner?.userId ?? null },
    });
  }

  // --- helpers / scoping (mirror RaceService; 404 not 403) ----------------
  private async assertGamesEnabled(tx: TenantTx, schoolId: string): Promise<void> {
    const settings = effectiveGameSettings(await tx.gameSettings.findFirst({ where: { schoolId } }));
    if (!settings.gamesEnabled) throw new ForbiddenException("Games are disabled for your school");
  }

  private async assertTeacherOfClass(tx: TenantTx, p: Principal, classId: string): Promise<void> {
    const cls = await tx.class.findFirst({ where: { id: classId }, select: { id: true } });
    if (!cls) throw new NotFoundException("Class not found");
    if (this.isSchoolWide(p)) return;
    const teaches = await tx.classTeacher.findFirst({ where: { classId, teacherId: p.userId }, select: { id: true } });
    if (!teaches) throw new NotFoundException("Class not found");
  }

  private async assertEnrolled(tx: TenantTx, p: Principal, classId: string): Promise<void> {
    if (this.isSchoolWide(p)) return;
    const enrolled = await tx.enrollment.findFirst({ where: { classId, studentId: p.userId }, select: { id: true } });
    if (!enrolled) throw new NotFoundException("Round not found");
  }

  private async assertHost(tx: TenantTx, p: Principal, game: { hostId: string; classId: string }): Promise<void> {
    if (this.isSchoolWide(p) || game.hostId === p.userId) return;
    const teaches = await tx.classTeacher.findFirst({
      where: { classId: game.classId, teacherId: p.userId },
      select: { id: true },
    });
    if (!teaches) throw new NotFoundException("Round not found");
  }

  private async assertCanView(
    tx: TenantTx,
    p: Principal,
    game: { id: string; hostId: string; classId: string },
  ): Promise<void> {
    if (this.isSchoolWide(p) || game.hostId === p.userId) return;
    const seat = await tx.hangmanPlayer.findFirst({ where: { gameId: game.id, userId: p.userId } });
    if (seat) return;
    const teaches = await tx.classTeacher.findFirst({
      where: { classId: game.classId, teacherId: p.userId },
      select: { id: true },
    });
    if (teaches) return;
    const enrolled = await tx.enrollment.findFirst({
      where: { classId: game.classId, studentId: p.userId },
      select: { id: true },
    });
    if (enrolled) return;
    throw new NotFoundException("Round not found");
  }

  private async requireGame(tx: TenantTx, gameId: string) {
    const game = await tx.hangmanGame.findFirst({ where: { id: gameId } });
    if (!game) throw new NotFoundException("Round not found");
    return game;
  }

  private async displayName(tx: TenantTx, userId: string): Promise<string> {
    const u = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
    return u?.name ?? "Player";
  }

  /** Build the viewer-redacted round view. SECURITY: the word is exposed only
   *  when FINISHED; each player sees only their own masked word. */
  private async buildView(tx: TenantTx, gameId: string, p: Principal): Promise<HangmanGameDto> {
    const game = await this.requireGame(tx, gameId);
    const difficulty = (isGameDifficulty(game.difficulty) ? game.difficulty : "MEDIUM") as GameDifficulty;
    const lives = HANGMAN_DIFFICULTY_SPECS[difficulty].lives;
    const isHost = this.isSchoolWide(p) || game.hostId === p.userId;

    const players = await tx.hangmanPlayer.findMany({ where: { gameId } });
    const me = players.find((pl) => pl.userId === p.userId) ?? null;

    // Word length: known from the stored word (live) or the length is implicit in
    // any player's guessed reconstruction. When finished the word is null, so use
    // the winner's/host's knowledge; fall back to 0 if truly unavailable.
    const finished = game.status === "FINISHED";
    // The word is retained (revealed on finish), so its length is always known.
    const wordLength = game.word ? game.word.length : 0;

    let you: HangmanGameDto["you"] = null;
    if (me) {
      const guessed = me.guessed as unknown as string[];
      const state = game.word ? this.rebuild(game.word, game.difficulty, guessed) : null;
      you = {
        playerId: me.id,
        // On finish, show the full word to every player; else the engine mask.
        masked: finished && game.word ? game.word : state ? maskedWord(state) : "_".repeat(wordLength),
        guessed,
        wrong: me.wrong,
        livesRemaining: state ? livesRemaining(state) : Math.max(0, lives - me.wrong),
        status: me.status as HangmanGuessResultDto["status"],
        rank: me.rank,
      };
    }

    const solvers = players
      .filter((pl) => pl.status === "WON" && pl.rank != null)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const leaderboard = [];
    for (const s of solvers) {
      leaderboard.push({
        userId: s.userId,
        displayName: await this.displayName(tx, s.userId),
        rank: s.rank as number,
        wrong: s.wrong,
      });
    }

    return {
      id: game.id,
      classId: game.classId,
      difficulty: game.difficulty as HangmanDifficultyDto,
      status: game.status as HangmanGameDto["status"],
      wordLength,
      lives,
      participantCount: players.length,
      startedAt: game.startedAt,
      finishedAt: game.finishedAt,
      isHost,
      you,
      leaderboard,
      winnerUserId: game.winnerUserId,
      // SECURITY: the word crosses the wire ONLY once the round is FINISHED.
      word: finished ? game.word ?? null : null,
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
      { actorId: p.userId, action, entity: "hangman", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
