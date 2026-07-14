// =============================================================================
// ChessService — turn-based 2-player chess (SMS integration)
// =============================================================================
// A peer duel: a player CREATES a game (plays white, moves first), another in the
// same school JOINS as black, and they alternate turns. Every move is validated
// SERVER-SIDE against the full-rules engine (@sms/game-engine `chess`) — clients
// are display-only (spec §9). The complete state that decides legality (castling
// rights, en-passant target, half-move clock) is persisted so the engine is
// rebuilt exactly each move.
//
// Security posture (standard built-module pattern):
//   - Tenant isolation: schoolId from the JWT on every row; RLS backstops.
//   - Relationship scoping: only the two participants may move/resign; ACTIVE/
//     FINISHED games are viewable by participants + school-wide staff; LOBBY
//     games are joinable by anyone in the school. 404-not-403.
//   - Server authority: moves applied via the engine; check/mate/stalemate/draw
//     and turn order computed here. Every mutation audit-logged. No clock in v1.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { BOARD_TIME_CONTROLS, chess, isGameDifficulty, type GameDifficulty } from "@sms/game-engine";
import { Prisma } from "@sms/db";
import type {
  ChessBoardDto,
  ChessColor,
  ChessEngineStatusDto,
  ChessGameDto,
  ChessMoveDto,
  ChessSummaryDto,
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
import { effectiveGameSettings } from "./game-settings.util";
import { GameEventsService } from "./game-events.service";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal", "super_admin"]);

type GameRow = {
  board: unknown;
  castling: unknown;
  ep: unknown;
  halfmove: number;
  fullmove: number;
  turn: string;
  chessStatus: string;
};

@Injectable()
export class ChessService {
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
  /** Create a game; the creator plays white (moves first). */
  async createGame(p: Principal, input: { difficulty?: string } = {}): Promise<ChessGameDto> {
    return this.withEmit(p, null, async (tx) => {
      await this.assertGamesEnabled(tx, p.schoolId);
      const difficulty = this.difficultyOf(input.difficulty);
      const base = BOARD_TIME_CONTROLS[difficulty].baseSeconds * 1000;
      const s = chess.newChessGame();
      const game = await tx.chessGame.create({
        data: {
          schoolId: p.schoolId,
          status: "LOBBY",
          createdById: p.userId,
          whiteUserId: p.userId,
          turn: "w",
          board: s.board as unknown as Prisma.InputJsonValue,
          castling: s.castling as unknown as Prisma.InputJsonValue,
          ep: Prisma.DbNull,
          halfmove: s.halfmove,
          fullmove: s.fullmove,
          chessStatus: "PLAYING",
          difficulty,
          whiteTimeMs: base,
          blackTimeMs: base,
        },
      });
      await this.log(tx, p, "chess.create", game.id, { difficulty });
      return this.buildView(tx, game.id, p);
    });
  }

  async joinGame(p: Principal, gameId: string): Promise<ChessGameDto> {
    return this.withEmit(p, gameId, async (tx) => {
      const game = await this.requireGame(tx, gameId);
      if (game.status !== "LOBBY" || game.blackUserId) throw new ConflictException("Game is not open to join");
      if (game.whiteUserId === p.userId) throw new ConflictException("You can't join your own game");
      await tx.chessGame.update({
        where: { id: gameId },
        data: { blackUserId: p.userId, status: "ACTIVE", startedAt: new Date(), turnStartedAt: new Date() },
      });
      await this.log(tx, p, "chess.join", gameId);
      return this.buildView(tx, gameId, p);
    });
  }

  /** Apply a move on the caller's turn (validated by the engine). Deducts the
   *  turn's elapsed time from the mover's clock (flag-fall = loss) + increment. */
  async move(p: Principal, gameId: string, move: ChessMoveDto): Promise<ChessGameDto> {
    return this.withEmit(p, gameId, async (tx) => {
      const game = await this.requireGame(tx, gameId);
      if (game.status !== "ACTIVE") throw new ConflictException("Game is not in play");
      const color = this.colorOf(game, p.userId);
      if (!color) throw new NotFoundException("Game not found"); // relationship scope
      if (game.turn !== color) throw new ConflictException("It is not your turn");

      // Clock: has the mover already run out of time on this turn?
      const now = Date.now();
      const moverTime = color === "w" ? game.whiteTimeMs : game.blackTimeMs;
      const elapsed = game.turnStartedAt ? now - game.turnStartedAt.getTime() : 0;
      const remaining = moverTime - elapsed;
      if (remaining <= 0) {
        const winner = color === "w" ? game.blackUserId : game.whiteUserId;
        await tx.chessGame.update({
          where: { id: gameId },
          data: {
            status: "FINISHED", finishedAt: new Date(), winnerUserId: winner, outcome: "TIME", turnStartedAt: null,
            ...(color === "w" ? { whiteTimeMs: 0 } : { blackTimeMs: 0 }),
          },
        });
        await this.log(tx, p, "chess.flag", gameId);
        return this.buildView(tx, gameId, p);
      }

      const state = this.toState(game);
      let next: chess.ChessState;
      try {
        next = chess.applyMove(state, move as unknown as chess.ChessMove);
      } catch {
        throw new BadRequestException("Illegal move");
      }

      const inc = BOARD_TIME_CONTROLS[this.difficultyOf(game.difficulty)].incrementSeconds * 1000;
      const newMoverTime = remaining + inc;
      const finished = next.status === "CHECKMATE" || next.status === "STALEMATE" || next.status === "DRAW";
      const winnerUserId =
        next.status === "CHECKMATE" ? (color === "w" ? game.whiteUserId : game.blackUserId) : null;
      await tx.chessGame.update({
        where: { id: gameId },
        data: {
          board: next.board as unknown as Prisma.InputJsonValue,
          castling: next.castling as unknown as Prisma.InputJsonValue,
          ep: next.ep ? (next.ep as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          halfmove: next.halfmove,
          fullmove: next.fullmove,
          turn: next.turn,
          chessStatus: next.status,
          moveCount: game.moveCount + 1,
          ...(color === "w" ? { whiteTimeMs: newMoverTime } : { blackTimeMs: newMoverTime }),
          turnStartedAt: finished ? null : new Date(),
          ...(finished ? { status: "FINISHED", finishedAt: new Date(), winnerUserId, outcome: next.status } : {}),
        },
      });
      await this.log(tx, p, "chess.move", gameId, { moveCount: game.moveCount + 1, status: next.status });
      return this.buildView(tx, gameId, p);
    });
  }

  /** Claim the win when it's the OPPONENT's move and their clock has run out. */
  async claimTime(p: Principal, gameId: string): Promise<ChessGameDto> {
    return this.withEmit(p, gameId, async (tx) => {
      const game = await this.requireGame(tx, gameId);
      if (game.status !== "ACTIVE") throw new ConflictException("Game is not in play");
      const color = this.colorOf(game, p.userId);
      if (!color) throw new NotFoundException("Game not found");
      if (color === game.turn) throw new ConflictException("It's your move — you can't claim your own clock");
      const curTime = game.turn === "w" ? game.whiteTimeMs : game.blackTimeMs;
      const elapsed = game.turnStartedAt ? Date.now() - game.turnStartedAt.getTime() : 0;
      if (curTime - elapsed > 0) throw new ConflictException("Your opponent still has time");
      const winner = color === "w" ? game.whiteUserId : game.blackUserId;
      await tx.chessGame.update({
        where: { id: gameId },
        data: {
          status: "FINISHED", finishedAt: new Date(), winnerUserId: winner, outcome: "TIME", turnStartedAt: null,
          ...(game.turn === "w" ? { whiteTimeMs: 0 } : { blackTimeMs: 0 }),
        },
      });
      await this.log(tx, p, "chess.claim_time", gameId);
      return this.buildView(tx, gameId, p);
    });
  }

  /** Resign — the other player wins. */
  async resign(p: Principal, gameId: string): Promise<ChessGameDto> {
    return this.withEmit(p, gameId, async (tx) => {
      const game = await this.requireGame(tx, gameId);
      if (game.status !== "ACTIVE") throw new ConflictException("Game is not in play");
      const color = this.colorOf(game, p.userId);
      if (!color) throw new NotFoundException("Game not found");
      const winnerUserId = color === "w" ? game.blackUserId : game.whiteUserId;
      await tx.chessGame.update({
        where: { id: gameId },
        data: { status: "FINISHED", finishedAt: new Date(), winnerUserId, outcome: "RESIGN" },
      });
      await this.log(tx, p, "chess.resign", gameId);
      return this.buildView(tx, gameId, p);
    });
  }

  // --- reads --------------------------------------------------------------
  async getGame(p: Principal, gameId: string): Promise<ChessGameDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const game = await this.requireGame(tx, gameId);
      if (game.status !== "LOBBY" && !this.isSchoolWide(p) && !this.colorOf(game, p.userId)) {
        throw new NotFoundException("Game not found");
      }
      return this.buildView(tx, gameId, p);
    });
  }

  async listGames(p: Principal): Promise<ChessSummaryDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const games = await tx.chessGame.findMany({
        where: {
          OR: [
            { status: "LOBBY", blackUserId: null }, // joinable
            { whiteUserId: p.userId },
            { blackUserId: p.userId },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
      });
      if (games.length === 0) return [];
      const userIds = [...new Set(games.flatMap((g) => [g.whiteUserId, g.blackUserId].filter((u): u is string => !!u)))];
      const names = await this.displayNames(tx, userIds);
      return games.map((g) => {
        const yourColor = this.colorOf(g, p.userId);
        return {
          id: g.id,
          status: g.status as ChessSummaryDto["status"],
          whiteName: names.get(g.whiteUserId) ?? "Player",
          blackName: g.blackUserId ? names.get(g.blackUserId) ?? "Player" : null,
          yourColor,
          isYourTurn: g.status === "ACTIVE" && !!yourColor && g.turn === yourColor,
          createdAt: g.createdAt,
        };
      });
    });
  }

  // =========================================================================
  // internals
  // =========================================================================
  private colorOf(game: { whiteUserId: string; blackUserId: string | null }, userId: string): ChessColor | null {
    if (game.whiteUserId === userId) return "w";
    if (game.blackUserId === userId) return "b";
    return null;
  }

  private difficultyOf(d?: string | null): GameDifficulty {
    return d && isGameDifficulty(d) ? d : "MEDIUM";
  }

  /** Rebuild the engine state from the persisted row. */
  private toState(game: GameRow): chess.ChessState {
    return {
      board: game.board as unknown as chess.Board,
      turn: game.turn as chess.Color,
      castling: game.castling as unknown as chess.CastlingRights,
      ep: (game.ep as unknown as chess.Sq | null) ?? null,
      halfmove: game.halfmove,
      fullmove: game.fullmove,
      status: game.chessStatus as chess.ChessStatus,
    };
  }

  private async assertGamesEnabled(tx: TenantTx, schoolId: string): Promise<void> {
    const settings = effectiveGameSettings(await tx.gameSettings.findFirst({ where: { schoolId } }));
    if (!settings.gamesEnabled) throw new ForbiddenException("Games are disabled for your school");
  }

  private async requireGame(tx: TenantTx, gameId: string) {
    const game = await tx.chessGame.findFirst({ where: { id: gameId } });
    if (!game) throw new NotFoundException("Game not found");
    return game;
  }

  private async displayNames(tx: TenantTx, userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name ?? "Player"]));
  }

  private async buildView(tx: TenantTx, gameId: string, p: Principal): Promise<ChessGameDto> {
    const game = await this.requireGame(tx, gameId);
    const names = await this.displayNames(tx, [game.whiteUserId, game.blackUserId].filter((u): u is string => !!u));
    const yourColor = this.colorOf(game, p.userId);
    const yourTurn = game.status === "ACTIVE" && !!yourColor && game.turn === yourColor;

    let legalMoves: ChessMoveDto[] = [];
    if (yourTurn) {
      legalMoves = chess.legalMoves(this.toState(game)) as unknown as ChessMoveDto[];
    }

    return {
      id: game.id,
      status: game.status as ChessGameDto["status"],
      board: game.board as unknown as ChessBoardDto,
      turn: game.turn as ChessColor,
      chessStatus: game.chessStatus as ChessEngineStatusDto,
      moveCount: game.moveCount,
      white: { userId: game.whiteUserId, displayName: names.get(game.whiteUserId) ?? "Player" },
      black: game.blackUserId
        ? { userId: game.blackUserId, displayName: names.get(game.blackUserId) ?? "Player" }
        : null,
      yourColor,
      yourTurn,
      legalMoves,
      winnerUserId: game.winnerUserId,
      outcome: game.outcome,
      difficulty: this.difficultyOf(game.difficulty) as "EASY" | "MEDIUM" | "HARD",
      whiteTimeMs: game.whiteTimeMs,
      blackTimeMs: game.blackTimeMs,
      turnStartedAt: game.turnStartedAt,
      createdAt: game.createdAt,
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
      { actorId: p.userId, action, entity: "chess", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
