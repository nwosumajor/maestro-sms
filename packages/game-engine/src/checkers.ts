// =============================================================================
// Checkers / Draughts (8x8 English rules) — pure rules engine
// =============================================================================
// Two players (BLACK moves first, per English draughts). Men move one diagonal
// square forward; kings move diagonally in both directions. Captures are by
// jumping an adjacent enemy piece into the empty square beyond, are MANDATORY
// when available, and a multi-jump must continue until no further jump exists
// from the landing square. Reaching the far back rank crowns a man (and, if
// crowned by a jump, ends the move — standard rule). A side with no legal move
// loses.
//
// Pure + framework-independent: immutable state in, new state out. Difficulty is
// a time control (see `difficulty`), so the board/rules never change — fair.
// =============================================================================

export type CheckerColor = "b" | "w";
export interface CheckerPiece {
  color: CheckerColor;
  king: boolean;
}
/** 8x8 board; `null` = empty. Only dark squares ((r+c) odd) are ever occupied. */
export type CheckerBoard = (CheckerPiece | null)[][];
export type Sq = [number, number]; // [row, col], 0..7

export interface CheckersState {
  readonly board: CheckerBoard;
  readonly turn: CheckerColor;
  readonly status: "PLAYING" | "B_WON" | "W_WON";
}

/** A full move: the landing-square path and the squares captured en route. */
export interface CheckersMove {
  from: Sq;
  /** Landing squares in order (length 1 for a simple move). */
  path: Sq[];
  /** Captured squares (empty for a simple move), in order. */
  captured: Sq[];
}

const inBounds = (r: number, c: number): boolean => r >= 0 && r < 8 && c >= 0 && c < 8;
const isDark = (r: number, c: number): boolean => (r + c) % 2 === 1;

/** The standard opening position: black on rows 0–2, white on rows 5–7. */
export function newCheckersGame(): CheckersState {
  const board: CheckerBoard = Array.from({ length: 8 }, () => Array<CheckerPiece | null>(8).fill(null));
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (!isDark(r, c)) continue;
      if (r <= 2) board[r]![c] = { color: "b", king: false };
      else if (r >= 5) board[r]![c] = { color: "w", king: false };
    }
  }
  return { board, turn: "b", status: "PLAYING" };
}

/** Forward row directions for a man: black moves down (+1), white up (-1). */
function manDirs(color: CheckerColor): number[] {
  return color === "b" ? [1] : [-1];
}
function moveRowDirs(p: CheckerPiece): number[] {
  return p.king ? [1, -1] : manDirs(p.color);
}

const cloneBoard = (b: CheckerBoard): CheckerBoard => b.map((row) => row.slice());
const reachedBackRank = (color: CheckerColor, r: number): boolean =>
  (color === "b" && r === 7) || (color === "w" && r === 0);

/**
 * All legal moves for the side to move. Captures are mandatory: if ANY capture
 * exists, only captures (fully-extended multi-jumps) are returned; otherwise the
 * simple diagonal steps are returned. Empty array = the side has lost.
 */
export function legalMoves(state: CheckersState): CheckersMove[] {
  if (state.status !== "PLAYING") return [];
  const { board, turn } = state;
  const captures: CheckersMove[] = [];
  const simple: CheckersMove[] = [];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r]![c];
      if (!p || p.color !== turn) continue;
      collectJumps(board, p, [r, c], [r, c], [], [], captures);
      if (captures.length === 0) collectSteps(board, p, [r, c], simple);
    }
  }
  return captures.length > 0 ? captures : simple;
}

/** Simple (non-capturing) one-square diagonal moves for a piece. */
function collectSteps(board: CheckerBoard, p: CheckerPiece, from: Sq, out: CheckersMove[]): void {
  for (const dr of moveRowDirs(p)) {
    for (const dc of [-1, 1]) {
      const nr = from[0] + dr;
      const nc = from[1] + dc;
      if (inBounds(nr, nc) && board[nr]![nc] === null) {
        out.push({ from, path: [[nr, nc]], captured: [] });
      }
    }
  }
}

/**
 * Depth-first enumeration of multi-jump capture sequences from `cur`. A man that
 * is crowned by landing on the back rank STOPS (cannot continue as a king in the
 * same move — standard English rule). Only maximal chains (no further jump
 * available) are emitted.
 */
function collectJumps(
  board: CheckerBoard,
  p: CheckerPiece,
  origin: Sq,
  cur: Sq,
  path: Sq[],
  captured: Sq[],
  out: CheckersMove[],
): void {
  let extended = false;
  for (const dr of moveRowDirs(p)) {
    for (const dc of [-1, 1]) {
      const mr = cur[0] + dr; // mid (captured) square
      const mc = cur[1] + dc;
      const lr = cur[0] + 2 * dr; // landing square
      const lc = cur[1] + 2 * dc;
      if (!inBounds(lr, lc) || board[lr]![lc] !== null) continue;
      const mid = inBounds(mr, mc) ? board[mr]![mc] : null;
      if (!mid || mid.color === p.color) continue;
      if (captured.some(([cr, cc]) => cr === mr && cc === mc)) continue; // no re-capture

      extended = true;
      // Simulate the jump on a scratch board so further jumps see it removed.
      const nb = cloneBoard(board);
      nb[cur[0]]![cur[1]] = null;
      nb[mr]![mc] = null;
      const crowned = !p.king && reachedBackRank(p.color, lr);
      const moved: CheckerPiece = { color: p.color, king: p.king || crowned };
      nb[lr]![lc] = moved;

      const nextPath = [...path, [lr, lc] as Sq];
      const nextCap = [...captured, [mr, mc] as Sq];
      if (crowned) {
        out.push({ from: origin, path: nextPath, captured: nextCap });
      } else {
        const before = out.length;
        collectJumps(nb, moved, origin, [lr, lc], nextPath, nextCap, out);
        // Dead end (no further jump) → this chain is maximal; emit it.
        if (out.length === before) out.push({ from: origin, path: nextPath, captured: nextCap });
      }
    }
  }
  void extended;
}

/** Structural equality of two moves (used to validate a submitted move). */
export function movesEqual(a: CheckersMove, b: CheckersMove): boolean {
  const sqEq = (x: Sq, y: Sq) => x[0] === y[0] && x[1] === y[1];
  const listEq = (x: Sq[], y: Sq[]) => x.length === y.length && x.every((s, i) => sqEq(s, y[i]!));
  return sqEq(a.from, b.from) && listEq(a.path, b.path) && listEq(a.captured, b.captured);
}

/**
 * Apply a move that MUST be one of `legalMoves(state)` (validated by equality).
 * Returns the new state with the piece moved, captures removed, kinging applied,
 * turn switched, and terminal status set when the next side has no move. Throws
 * on an illegal move (server authority — never silently accept a bad move).
 */
export function applyMove(state: CheckersState, move: CheckersMove): CheckersState {
  const legal = legalMoves(state);
  if (!legal.some((m) => movesEqual(m, move))) {
    throw new Error("applyMove: illegal checkers move");
  }
  const board = cloneBoard(state.board);
  const [fr, fc] = move.from;
  const piece = board[fr]![fc]!;
  board[fr]![fc] = null;
  for (const [cr, cc] of move.captured) board[cr]![cc] = null;
  const dest = move.path[move.path.length - 1]!;
  const [dr, dc] = dest;
  const crowned = !piece.king && reachedBackRank(piece.color, dr);
  board[dr]![dc] = { color: piece.color, king: piece.king || crowned };

  const nextTurn: CheckerColor = state.turn === "b" ? "w" : "b";
  const next: CheckersState = { board, turn: nextTurn, status: "PLAYING" };
  // The side to move next has no legal reply → they lose.
  if (legalMoves(next).length === 0) {
    return { ...next, status: state.turn === "b" ? "B_WON" : "W_WON" };
  }
  return next;
}

/** Count a colour's pieces (for UI / draw heuristics). */
export function pieceCount(board: CheckerBoard, color: CheckerColor): number {
  let n = 0;
  for (const row of board) for (const cell of row) if (cell?.color === color) n++;
  return n;
}
