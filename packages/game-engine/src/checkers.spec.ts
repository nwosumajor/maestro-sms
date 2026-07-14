import {
  newCheckersGame,
  legalMoves,
  applyMove,
  pieceCount,
  type CheckerBoard,
  type CheckerColor,
  type CheckersState,
} from "./checkers";

function emptyBoard(): CheckerBoard {
  return Array.from({ length: 8 }, () => Array(8).fill(null));
}
function state(
  place: Array<[number, number, CheckerColor, boolean?]>,
  turn: CheckerColor,
): CheckersState {
  const board = emptyBoard();
  for (const [r, c, color, king] of place) board[r]![c] = { color, king: !!king };
  return { board, turn, status: "PLAYING" };
}

describe("Checkers engine", () => {
  it("opens with 12 pieces each, Black to move, only simple moves", () => {
    const g = newCheckersGame();
    expect(g.turn).toBe("b");
    expect(pieceCount(g.board, "b")).toBe(12);
    expect(pieceCount(g.board, "w")).toBe(12);
    const moves = legalMoves(g);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.captured.length === 0)).toBe(true);
    // black men advance downward (increasing row)
    expect(moves.every((m) => m.path[0]![0] > m.from[0])).toBe(true);
  });

  it("captures are MANDATORY — simple moves suppressed when a jump exists", () => {
    // black [2,1] can jump white [3,2] landing [4,3]; another black man [2,5]
    // has only simple steps, which must be hidden while the capture is available.
    const s = state([[2, 1, "b"], [2, 5, "b"], [3, 2, "w"]], "b");
    const moves = legalMoves(s);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.captured.length > 0)).toBe(true);
    const jump = moves[0]!;
    expect(jump.from).toEqual([2, 1]);
    expect(jump.path).toEqual([[4, 3]]);
    expect(jump.captured).toEqual([[3, 2]]);
  });

  it("finds a multi-jump chain and removes every captured piece", () => {
    // black [0,1] jumps [1,2]→[2,3] then [3,2]→[4,1].
    const s = state([[0, 1, "b"], [1, 2, "w"], [3, 2, "w"]], "b");
    const moves = legalMoves(s);
    const dbl = moves.find((m) => m.captured.length === 2);
    expect(dbl).toBeDefined();
    expect(dbl!.path).toEqual([[2, 3], [4, 1]]);
    const after = applyMove(s, dbl!);
    expect(pieceCount(after.board, "w")).toBe(0);
    expect(after.board[4]![1]).toEqual({ color: "b", king: false });
  });

  it("crowns a man that reaches the far back rank", () => {
    const s = state([[6, 1, "b"], [1, 0, "w"]], "b");
    const move = legalMoves(s).find((m) => m.path[0]![0] === 7)!;
    const after = applyMove(s, move);
    const dest = move.path[0]!;
    expect(after.board[dest[0]]![dest[1]]).toEqual({ color: "b", king: true });
  });

  it("a side with no move loses", () => {
    // white man stuck on the top edge ([0,1] cannot move up); after Black moves,
    // White has no reply → Black wins.
    const s = state([[2, 3, "b"], [0, 1, "w"]], "b");
    const simple = legalMoves(s).find((m) => m.captured.length === 0)!;
    const after = applyMove(s, simple);
    expect(after.status).toBe("B_WON");
  });

  it("rejects an illegal move", () => {
    const g = newCheckersGame();
    expect(() => applyMove(g, { from: [2, 1], path: [[4, 3]], captured: [] })).toThrow();
  });
});
