// Chess (turn-based 2-player) response DTOs. Server-form (Date fields are Date);
// the web consumes Serialized<…>. Perfect-information game: the whole board is
// public and the server offers the current player's legal moves.

export type ChessColor = "w" | "b";
export type ChessPieceType = "p" | "n" | "b" | "r" | "q" | "k";
export type ChessGameStatusDto = "LOBBY" | "ACTIVE" | "FINISHED";
export type ChessEngineStatusDto = "PLAYING" | "CHECK" | "CHECKMATE" | "STALEMATE" | "DRAW";

export interface ChessPieceDto {
  color: ChessColor;
  type: ChessPieceType;
}
export type ChessBoardDto = (ChessPieceDto | null)[][];
export type ChessSq = [number, number];

/** A move (engine ChessMove): from/to, plus promotion piece / castle side. */
export interface ChessMoveDto {
  from: ChessSq;
  to: ChessSq;
  promotion?: "q" | "r" | "b" | "n";
  castle?: "K" | "Q";
}

export interface ChessPlayerDto {
  userId: string;
  displayName: string;
}

/** A chess game, for the requesting viewer. */
export interface ChessGameDto {
  id: string;
  status: ChessGameStatusDto;
  /** Row 0 = rank 8 (black back rank) … row 7 = rank 1 (white). */
  board: ChessBoardDto;
  turn: ChessColor;
  /** Engine status for display (check / mate / stalemate / draw). */
  chessStatus: ChessEngineStatusDto;
  moveCount: number;
  white: ChessPlayerDto;
  black: ChessPlayerDto | null;
  yourColor: ChessColor | null;
  yourTurn: boolean;
  /** The viewer's legal moves (only when it's their turn; else empty). */
  legalMoves: ChessMoveDto[];
  winnerUserId: string | null;
  outcome: string | null;
  /** Time control + live clocks. */
  difficulty: "EASY" | "MEDIUM" | "HARD";
  /** Remaining clock per player (ms) as of the last move. */
  whiteTimeMs: number;
  blackTimeMs: number;
  /** When the current turn began — the client ticks the active clock from here. */
  turnStartedAt: Date | null;
  createdAt: Date;
}

/** A game in the lobby/active lists. */
export interface ChessSummaryDto {
  id: string;
  status: ChessGameStatusDto;
  whiteName: string;
  blackName: string | null;
  yourColor: ChessColor | null;
  isYourTurn: boolean;
  createdAt: Date;
}
