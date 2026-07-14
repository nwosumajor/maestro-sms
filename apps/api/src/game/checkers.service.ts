// =============================================================================
// CheckersService — turn-based 2-player checkers (SMS integration)
// =============================================================================
// A peer duel: a player CREATES a game (plays black, moves first), another in the
// same school JOINS as white, and they alternate turns. Every move is validated
// SERVER-SIDE against the pure engine (@sms/game-engine `checkers`) — clients are
// display-only (spec §9). Perfect-information game, so the board is public and
// the server offers the current player's legal moves.
//
// Security posture (standard built-module pattern):
//   - Tenant isolation: schoolId from the JWT on every row; RLS backstops.
//   - Relationship scoping: only the two participants may move/resign; ACTIVE/
//     FINISHED games are viewable by participants + school-wide staff; LOBBY
//     games are joinable by anyone in the school. 404-not-403.
//   - Server authority: the move is applied via the engine (which validates it
//     against legalMoves); turn order + win detection are computed here.
//   - Every mutation is audit-logged (Golden Rule #5). No enforced clock in v1.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { checkers } from "@sms/game-engine";
import { Prisma } from "@sms/db";
import type {
  CheckerBoardDto,
  CheckersColor,
  CheckersGameDto,
  CheckersMoveDto,
  CheckersSummaryDto,
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

@Injectable()
export class CheckersService {
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
  /** Create a game; the creator plays black (moves first). */
  async createGame(p: Principal): Promise<CheckersGameDto> {
    return this.withEmit(p, null, async (tx) => {
      await this.assertGamesEnabled(tx, p.schoolId);
      const fresh = checkers.newCheckersGame();
      const game = await tx.checkersGame.create({
        data: {
          schoolId: p.schoolId,
          status: "LOBBY",
          createdById: p.userId,
          blackUserId: p.userId,
          turn: "b",
          board: fresh.board as unknown as Prisma.InputJsonValue,
        },
      });
      await this.log(tx, p, "checkers.create", game.id);
      return this.buildView(tx, game.id, p);
    });
  }

  /** Join an open game as white. */
  async joinGame(p: Principal, gameId: string): Promise<CheckersGameDto> {
    return this.withEmit(p, gameId, async (tx) => {
      const game = await this.requireGame(tx, gameId);
      if (game.status !== "LOBBY" || game.whiteUserId) throw new ConflictException("Game is not open to join");
      if (game.blackUserId === p.userId) throw new ConflictException("You can't join your own game");
      await tx.checkersGame.update({
        where: { id: gameId },
        data: { whiteUserId: p.userId, status: "ACTIVE", startedAt: new Date() },
      });
      await this.log(tx, p, "checkers.join", gameId);
      return this.buildView(tx, gameId, p);
    });
  }

  /** Apply a move on the caller's turn (validated by the engine). */
  async move(p: Principal, gameId: string, move: CheckersMoveDto): Promise<CheckersGameDto> {
    return this.withEmit(p, gameId, async (tx) => {
      const game = await this.requireGame(tx, gameId);
      if (game.status !== "ACTIVE") throw new ConflictException("Game is not in play");
      const color = this.colorOf(game, p.userId);
      if (!color) throw new NotFoundException("Game not found"); // relationship scope
      if (game.turn !== color) throw new ConflictException("It is not your turn");

      const state: checkers.CheckersState = {
        board: game.board as unknown as checkers.CheckerBoard,
        turn: game.turn as checkers.CheckerColor,
        status: "PLAYING",
      };
      let next: checkers.CheckersState;
      try {
        next = checkers.applyMove(state, move as unknown as checkers.CheckersMove);
      } catch {
        throw new BadRequestException("Illegal move");
      }

      const finished = next.status !== "PLAYING";
      const winnerUserId = finished ? (next.status === "B_WON" ? game.blackUserId : game.whiteUserId) : null;
      await tx.checkersGame.update({
        where: { id: gameId },
        data: {
          board: next.board as unknown as Prisma.InputJsonValue,
          turn: next.turn,
          moveCount: game.moveCount + 1,
          ...(finished ? { status: "FINISHED", finishedAt: new Date(), winnerUserId, outcome: next.status } : {}),
        },
      });
      await this.log(tx, p, "checkers.move", gameId, { moveCount: game.moveCount + 1, finished });
      return this.buildView(tx, gameId, p);
    });
  }

  /** Resign — the other player wins. */
  async resign(p: Principal, gameId: string): Promise<CheckersGameDto> {
    return this.withEmit(p, gameId, async (tx) => {
      const game = await this.requireGame(tx, gameId);
      if (game.status !== "ACTIVE") throw new ConflictException("Game is not in play");
      const color = this.colorOf(game, p.userId);
      if (!color) throw new NotFoundException("Game not found");
      const winnerUserId = color === "b" ? game.whiteUserId : game.blackUserId;
      await tx.checkersGame.update({
        where: { id: gameId },
        data: { status: "FINISHED", finishedAt: new Date(), winnerUserId, outcome: "RESIGN" },
      });
      await this.log(tx, p, "checkers.resign", gameId);
      return this.buildView(tx, gameId, p);
    });
  }

  // --- reads --------------------------------------------------------------
  async getGame(p: Principal, gameId: string): Promise<CheckersGameDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const game = await this.requireGame(tx, gameId);
      // LOBBY games are joinable → viewable by anyone in the school; ACTIVE/
      // FINISHED only by participants + school-wide staff.
      if (game.status !== "LOBBY" && !this.isSchoolWide(p) && !this.colorOf(game, p.userId)) {
        throw new NotFoundException("Game not found");
      }
      return this.buildView(tx, gameId, p);
    });
  }

  /** Open games to join + the caller's own games (recent). */
  async listGames(p: Principal): Promise<CheckersSummaryDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const games = await tx.checkersGame.findMany({
        where: {
          OR: [
            { status: "LOBBY", whiteUserId: null }, // joinable
            { blackUserId: p.userId },
            { whiteUserId: p.userId },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
      });
      if (games.length === 0) return [];
      const userIds = [...new Set(games.flatMap((g) => [g.blackUserId, g.whiteUserId].filter((u): u is string => !!u)))];
      const names = await this.displayNames(tx, userIds);
      return games.map((g) => {
        const yourColor = this.colorOf(g, p.userId);
        return {
          id: g.id,
          status: g.status as CheckersSummaryDto["status"],
          blackName: names.get(g.blackUserId) ?? "Player",
          whiteName: g.whiteUserId ? names.get(g.whiteUserId) ?? "Player" : null,
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
  private colorOf(game: { blackUserId: string; whiteUserId: string | null }, userId: string): CheckersColor | null {
    if (game.blackUserId === userId) return "b";
    if (game.whiteUserId === userId) return "w";
    return null;
  }

  private async assertGamesEnabled(tx: TenantTx, schoolId: string): Promise<void> {
    const settings = effectiveGameSettings(await tx.gameSettings.findFirst({ where: { schoolId } }));
    if (!settings.gamesEnabled) throw new ForbiddenException("Games are disabled for your school");
  }

  private async requireGame(tx: TenantTx, gameId: string) {
    const game = await tx.checkersGame.findFirst({ where: { id: gameId } });
    if (!game) throw new NotFoundException("Game not found");
    return game;
  }

  private async displayNames(tx: TenantTx, userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name ?? "Player"]));
  }

  private async buildView(tx: TenantTx, gameId: string, p: Principal): Promise<CheckersGameDto> {
    const game = await this.requireGame(tx, gameId);
    const names = await this.displayNames(tx, [game.blackUserId, game.whiteUserId].filter((u): u is string => !!u));
    const yourColor = this.colorOf(game, p.userId);
    const yourTurn = game.status === "ACTIVE" && !!yourColor && game.turn === yourColor;

    let legalMoves: CheckersMoveDto[] = [];
    if (yourTurn) {
      const state: checkers.CheckersState = {
        board: game.board as unknown as checkers.CheckerBoard,
        turn: game.turn as checkers.CheckerColor,
        status: "PLAYING",
      };
      legalMoves = checkers.legalMoves(state) as unknown as CheckersMoveDto[];
    }

    return {
      id: game.id,
      status: game.status as CheckersGameDto["status"],
      board: game.board as unknown as CheckerBoardDto,
      turn: game.turn as CheckersColor,
      moveCount: game.moveCount,
      black: { userId: game.blackUserId, displayName: names.get(game.blackUserId) ?? "Player" },
      white: game.whiteUserId
        ? { userId: game.whiteUserId, displayName: names.get(game.whiteUserId) ?? "Player" }
        : null,
      yourColor,
      yourTurn,
      legalMoves,
      winnerUserId: game.winnerUserId,
      outcome: game.outcome,
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
      { actorId: p.userId, action, entity: "checkers", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
