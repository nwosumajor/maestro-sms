// Checkers (turn-based 2-player) response DTOs. Server-form (Date fields are
// Date); the web consumes Serialized<…>. Perfect-information game: the whole
// board is public, and the server offers the current player's legal moves.

export type CheckersColor = "b" | "w";
export type CheckersStatusDto = "LOBBY" | "ACTIVE" | "FINISHED";

/** A board cell: a piece or empty (null). Mirrors the engine CheckerPiece. */
export interface CheckerPieceDto {
  color: CheckersColor;
  king: boolean;
}
export type CheckerBoardDto = (CheckerPieceDto | null)[][];
export type CheckersSq = [number, number];

/** A full move: landing-square path + captured squares (engine CheckersMove). */
export interface CheckersMoveDto {
  from: CheckersSq;
  path: CheckersSq[];
  captured: CheckersSq[];
}

/** One player in the game. */
export interface CheckersPlayerDto {
  userId: string;
  displayName: string;
}

/** A checkers game, for the requesting viewer. */
export interface CheckersGameDto {
  id: string;
  status: CheckersStatusDto;
  board: CheckerBoardDto;
  turn: CheckersColor;
  moveCount: number;
  black: CheckersPlayerDto;
  white: CheckersPlayerDto | null;
  /** The viewer's colour, or null if a spectator/staff. */
  yourColor: CheckersColor | null;
  /** True when it is the viewer's turn to move. */
  yourTurn: boolean;
  /** The viewer's legal moves (only when it's their turn; else empty). */
  legalMoves: CheckersMoveDto[];
  winnerUserId: string | null;
  outcome: string | null;
  createdAt: Date;
}

/** A game in the lobby/active lists. */
export interface CheckersSummaryDto {
  id: string;
  status: CheckersStatusDto;
  blackName: string;
  whiteName: string | null;
  /** The viewer's colour if they're a participant, else null. */
  yourColor: CheckersColor | null;
  isYourTurn: boolean;
  createdAt: Date;
}
