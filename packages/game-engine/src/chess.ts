// =============================================================================
// Chess — pure, full-rules engine (legal move generation + game end)
// =============================================================================
// Complete standard rules: piece movement, check, checkmate, stalemate,
// castling (king/queen side, with the "not through check" rule), en passant,
// promotion, plus insufficient-material and 50-move draw detection. Two players;
// difficulty is a time control (see `difficulty`) — the rules never change.
//
// Pure + framework-independent: the server drives it (validate every submitted
// move against `legalMoves`), and clients are display-only (spec §9 authority).
// Board rows: row 0 = rank 8 (Black back rank) … row 7 = rank 1 (White). White
// pawns move toward row 0 (dir -1); Black pawns toward row 7 (dir +1).
// =============================================================================

export type Color = "w" | "b";
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";
export interface Piece {
  color: Color;
  type: PieceType;
}
export type Board = (Piece | null)[][]; // [row][col], 0..7
export type Sq = [number, number];

export interface CastlingRights {
  wK: boolean;
  wQ: boolean;
  bK: boolean;
  bQ: boolean;
}

export type ChessStatus = "PLAYING" | "CHECK" | "CHECKMATE" | "STALEMATE" | "DRAW";

export interface ChessState {
  readonly board: Board;
  readonly turn: Color;
  readonly castling: CastlingRights;
  /** En-passant TARGET square (the empty square a pawn skipped), or null. */
  readonly ep: Sq | null;
  /** Half-moves since the last capture or pawn move (for the 50-move rule). */
  readonly halfmove: number;
  readonly fullmove: number;
  readonly status: ChessStatus;
}

export interface ChessMove {
  from: Sq;
  to: Sq;
  /** Promotion piece when a pawn reaches the last rank; else undefined. */
  promotion?: Exclude<PieceType, "p" | "k">;
  /** "K" or "Q" when this is a castling move; else undefined. */
  castle?: "K" | "Q";
}

const inB = (r: number, c: number): boolean => r >= 0 && r < 8 && c >= 0 && c < 8;
const clone = (b: Board): Board => b.map((row) => row.slice());
const other = (c: Color): Color => (c === "w" ? "b" : "w");

/** Square name (a1..h8) ⇄ [row,col], handy for tests/UI. */
export function sqName([r, c]: Sq): string {
  return "abcdefgh"[c]! + (8 - r);
}
export function nameSq(name: string): Sq {
  return [8 - Number(name[1]), "abcdefgh".indexOf(name[0]!)];
}

/** Standard starting position. */
export function newChessGame(): ChessState {
  const back: PieceType[] = ["r", "n", "b", "q", "k", "b", "n", "r"];
  const board: Board = Array.from({ length: 8 }, () => Array<Piece | null>(8).fill(null));
  for (let c = 0; c < 8; c++) {
    board[0]![c] = { color: "b", type: back[c]! };
    board[1]![c] = { color: "b", type: "p" };
    board[6]![c] = { color: "w", type: "p" };
    board[7]![c] = { color: "w", type: back[c]! };
  }
  return {
    board,
    turn: "w",
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    ep: null,
    halfmove: 0,
    fullmove: 1,
    status: "PLAYING",
  };
}

const KNIGHT = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]] as const;
const KING = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]] as const;
const BISHOP = [[-1,-1],[-1,1],[1,-1],[1,1]] as const;
const ROOK = [[-1,0],[1,0],[0,-1],[0,1]] as const;

/** Is square [r,c] attacked by any piece of `by`? (Used for check + castling.) */
export function isAttacked(board: Board, [r, c]: Sq, by: Color): boolean {
  // Pawns: a `by` pawn attacks one rank toward its travel direction. White pawns
  // travel up (dir -1) and thus attack from row+1; Black from row-1.
  const pawnRow = by === "w" ? r + 1 : r - 1;
  for (const dc of [-1, 1]) {
    if (inB(pawnRow, c + dc)) {
      const p = board[pawnRow]![c + dc];
      if (p && p.color === by && p.type === "p") return true;
    }
  }
  for (const [dr, dc] of KNIGHT) {
    if (inB(r + dr, c + dc)) {
      const p = board[r + dr]![c + dc];
      if (p && p.color === by && p.type === "n") return true;
    }
  }
  for (const [dr, dc] of KING) {
    if (inB(r + dr, c + dc)) {
      const p = board[r + dr]![c + dc];
      if (p && p.color === by && p.type === "k") return true;
    }
  }
  for (const [dr, dc] of BISHOP) {
    if (raySees(board, r, c, dr, dc, by, "b", "q")) return true;
  }
  for (const [dr, dc] of ROOK) {
    if (raySees(board, r, c, dr, dc, by, "r", "q")) return true;
  }
  return false;
}

function raySees(
  board: Board, r: number, c: number, dr: number, dc: number,
  by: Color, t1: PieceType, t2: PieceType,
): boolean {
  let nr = r + dr, nc = c + dc;
  while (inB(nr, nc)) {
    const p = board[nr]![nc];
    if (p) return p.color === by && (p.type === t1 || p.type === t2);
    nr += dr; nc += dc;
  }
  return false;
}

function findKing(board: Board, color: Color): Sq | null {
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = board[r]![c];
      if (p && p.color === color && p.type === "k") return [r, c];
    }
  return null;
}

/** Is `color`'s king currently in check? */
export function inCheck(board: Board, color: Color): boolean {
  const k = findKing(board, color);
  return k ? isAttacked(board, k, other(color)) : false;
}

/**
 * Pseudo-legal moves (ignore leaving own king in check; castling added in
 * `legalMoves`). Promotions are expanded to the four options.
 */
function pseudoMoves(state: ChessState): ChessMove[] {
  const { board, turn, ep } = state;
  const moves: ChessMove[] = [];
  const add = (from: Sq, to: Sq) => moves.push({ from, to });

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r]![c];
      if (!p || p.color !== turn) continue;

      if (p.type === "p") {
        const dir = turn === "w" ? -1 : 1;
        const startRow = turn === "w" ? 6 : 1;
        const promoRow = turn === "w" ? 0 : 7;
        const one = r + dir;
        // forward
        if (inB(one, c) && board[one]![c] === null) {
          pushPawn(moves, [r, c], [one, c], one === promoRow);
          const two = r + 2 * dir;
          if (r === startRow && board[two]![c] === null) add([r, c], [two, c]);
        }
        // captures + en passant
        for (const dc of [-1, 1]) {
          const nr = r + dir, nc = c + dc;
          if (!inB(nr, nc)) continue;
          const target = board[nr]![nc];
          if (target && target.color !== turn) {
            pushPawn(moves, [r, c], [nr, nc], nr === promoRow);
          } else if (ep && ep[0] === nr && ep[1] === nc) {
            moves.push({ from: [r, c], to: [nr, nc] }); // en passant
          }
        }
      } else if (p.type === "n") {
        for (const [dr, dc] of KNIGHT) stepInto(board, [r, c], dr, dc, turn, add);
      } else if (p.type === "k") {
        for (const [dr, dc] of KING) stepInto(board, [r, c], dr, dc, turn, add);
      } else {
        const dirs = p.type === "b" ? BISHOP : p.type === "r" ? ROOK : [...BISHOP, ...ROOK];
        for (const [dr, dc] of dirs) slide(board, [r, c], dr, dc, turn, add);
      }
    }
  }
  return moves;
}

function pushPawn(moves: ChessMove[], from: Sq, to: Sq, promo: boolean): void {
  if (promo) {
    for (const pr of ["q", "r", "b", "n"] as const) moves.push({ from, to, promotion: pr });
  } else {
    moves.push({ from, to });
  }
}
function stepInto(board: Board, [r, c]: Sq, dr: number, dc: number, turn: Color, add: (f: Sq, t: Sq) => void): void {
  const nr = r + dr, nc = c + dc;
  if (!inB(nr, nc)) return;
  const t = board[nr]![nc];
  if (!t || t.color !== turn) add([r, c], [nr, nc]);
}
function slide(board: Board, [r, c]: Sq, dr: number, dc: number, turn: Color, add: (f: Sq, t: Sq) => void): void {
  let nr = r + dr, nc = c + dc;
  while (inB(nr, nc)) {
    const t = board[nr]![nc];
    if (!t) add([r, c], [nr, nc]);
    else {
      if (t.color !== turn) add([r, c], [nr, nc]);
      break;
    }
    nr += dr; nc += dc;
  }
}

/** Apply a move to a scratch board (no rights/status bookkeeping) for testing check. */
function boardAfter(state: ChessState, m: ChessMove): Board {
  const b = clone(state.board);
  const [fr, fc] = m.from;
  const [tr, tc] = m.to;
  const piece = b[fr]![fc]!;
  b[fr]![fc] = null;
  // en passant capture: the taken pawn is on the mover's own rank beside `to`.
  if (piece.type === "p" && state.ep && tr === state.ep[0] && tc === state.ep[1] && b[tr]![tc] === null) {
    b[fr]![tc] = null;
  }
  b[tr]![tc] = m.promotion ? { color: piece.color, type: m.promotion } : piece;
  // castling: move the rook too.
  if (m.castle === "K") { b[tr]![5] = b[tr]![7]; b[tr]![7] = null; }
  if (m.castle === "Q") { b[tr]![3] = b[tr]![0]; b[tr]![0] = null; }
  return b;
}

/** All FULLY-LEGAL moves for the side to move (own king never left in check). */
export function legalMoves(state: ChessState): ChessMove[] {
  if (state.status === "CHECKMATE" || state.status === "STALEMATE" || state.status === "DRAW") return [];
  const { board, turn } = state;
  const legal: ChessMove[] = [];

  for (const m of pseudoMoves(state)) {
    if (!inCheck(boardAfter(state, m), turn)) legal.push(m);
  }

  // Castling — only when not currently in check and the king does not pass
  // through or land on an attacked square, with empty squares between.
  const homeRow = turn === "w" ? 7 : 0;
  const rights = state.castling;
  const kingHome = board[homeRow]![4];
  if (kingHome && kingHome.type === "k" && kingHome.color === turn && !inCheck(board, turn)) {
    const enemy = other(turn);
    const canK = turn === "w" ? rights.wK : rights.bK;
    const canQ = turn === "w" ? rights.wQ : rights.bQ;
    if (
      canK && board[homeRow]![5] === null && board[homeRow]![6] === null &&
      isRook(board, homeRow, 7, turn) &&
      !isAttacked(board, [homeRow, 5], enemy) && !isAttacked(board, [homeRow, 6], enemy)
    ) {
      legal.push({ from: [homeRow, 4], to: [homeRow, 6], castle: "K" });
    }
    if (
      canQ && board[homeRow]![1] === null && board[homeRow]![2] === null && board[homeRow]![3] === null &&
      isRook(board, homeRow, 0, turn) &&
      !isAttacked(board, [homeRow, 3], enemy) && !isAttacked(board, [homeRow, 2], enemy)
    ) {
      legal.push({ from: [homeRow, 4], to: [homeRow, 2], castle: "Q" });
    }
  }
  return legal;
}

function isRook(board: Board, r: number, c: number, color: Color): boolean {
  const p = board[r]![c];
  return !!p && p.type === "r" && p.color === color;
}

/** Structural move equality (used to validate a submitted move). */
export function movesEqual(a: ChessMove, b: ChessMove): boolean {
  return (
    a.from[0] === b.from[0] && a.from[1] === b.from[1] &&
    a.to[0] === b.to[0] && a.to[1] === b.to[1] &&
    (a.promotion ?? null) === (b.promotion ?? null) &&
    (a.castle ?? null) === (b.castle ?? null)
  );
}

/**
 * Apply a move that MUST be legal (validated against `legalMoves`). Returns the
 * new state with castling rights, en-passant target, clocks, turn, and terminal
 * status all updated. Throws on an illegal move (server authority).
 */
export function applyMove(state: ChessState, move: ChessMove): ChessState {
  const legal = legalMoves(state);
  const chosen = legal.find((m) => movesEqual(m, move));
  if (!chosen) throw new Error("applyMove: illegal chess move");

  const board = clone(state.board);
  const [fr, fc] = chosen.from;
  const [tr, tc] = chosen.to;
  const piece = board[fr]![fc]!;
  const captured = board[tr]![tc];
  const isPawn = piece.type === "p";
  const isEnPassant = isPawn && state.ep !== null && tr === state.ep[0] && tc === state.ep[1] && captured === null;

  board[fr]![fc] = null;
  if (isEnPassant) board[fr]![tc] = null; // remove the passed pawn
  board[tr]![tc] = chosen.promotion ? { color: piece.color, type: chosen.promotion } : piece;
  if (chosen.castle === "K") { board[tr]![5] = board[tr]![7]; board[tr]![7] = null; }
  if (chosen.castle === "Q") { board[tr]![3] = board[tr]![0]; board[tr]![0] = null; }

  // Castling rights: king move drops both; rook move/capture drops that corner.
  const castling: CastlingRights = { ...state.castling };
  if (piece.type === "k") {
    if (piece.color === "w") { castling.wK = false; castling.wQ = false; }
    else { castling.bK = false; castling.bQ = false; }
  }
  dropRookRight(castling, fr, fc);
  dropRookRight(castling, tr, tc); // a rook captured on its home square

  // En passant target: only a two-square pawn push creates one.
  let ep: Sq | null = null;
  if (isPawn && Math.abs(tr - fr) === 2) ep = [(fr + tr) / 2, fc];

  const halfmove = isPawn || captured || isEnPassant ? 0 : state.halfmove + 1;
  const fullmove = state.turn === "b" ? state.fullmove + 1 : state.fullmove;
  const turn = other(state.turn);

  const next: ChessState = { board, turn, castling, ep, halfmove, fullmove, status: "PLAYING" };
  return { ...next, status: computeStatus(next) };
}

function dropRookRight(c: CastlingRights, r: number, col: number): void {
  if (r === 7 && col === 0) c.wQ = false;
  if (r === 7 && col === 7) c.wK = false;
  if (r === 0 && col === 0) c.bQ = false;
  if (r === 0 && col === 7) c.bK = false;
}

function computeStatus(state: ChessState): ChessStatus {
  if (insufficientMaterial(state.board) || state.halfmove >= 100) return "DRAW";
  const moves = legalMoves({ ...state, status: "PLAYING" });
  const checked = inCheck(state.board, state.turn);
  if (moves.length === 0) return checked ? "CHECKMATE" : "STALEMATE";
  return checked ? "CHECK" : "PLAYING";
}

/** Basic insufficient-material draws: K vs K, K+minor vs K, K+B vs K+B same colour. */
export function insufficientMaterial(board: Board): boolean {
  const pieces: { color: Color; type: PieceType; sqColor: number }[] = [];
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = board[r]![c];
      if (p && p.type !== "k") pieces.push({ color: p.color, type: p.type, sqColor: (r + c) % 2 });
    }
  if (pieces.length === 0) return true; // K vs K
  if (pieces.length === 1) return pieces[0]!.type === "b" || pieces[0]!.type === "n"; // K+minor vs K
  if (pieces.length === 2 && pieces.every((p) => p.type === "b")) {
    return pieces[0]!.sqColor === pieces[1]!.sqColor; // bishops on same colour
  }
  return false;
}

/** Compact "wPe2" style listing of all pieces — for snapshots/tests. */
export function describeBoard(board: Board): string {
  const out: string[] = [];
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = board[r]![c];
      if (p) out.push(p.color + p.type.toUpperCase() + sqName([r, c]));
    }
  return out.sort().join(" ");
}
