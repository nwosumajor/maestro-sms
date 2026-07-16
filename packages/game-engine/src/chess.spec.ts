import {
  newChessGame,
  legalMoves,
  applyMove,
  inCheck,
  insufficientMaterial,
  movesEqual,
  nameSq,
  positionKey,
  sqName,
  type Board,
  type ChessState,
  type Color,
  type PieceType,
  type ChessMove,
} from "./chess";

/** Build a position from {square: "wk"} codes (color + lowercase type). */
function makeState(map: Record<string, string>, turn: Color, over: Partial<ChessState> = {}): ChessState {
  const board: Board = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (const [name, code] of Object.entries(map)) {
    const [r, c] = nameSq(name);
    board[r]![c] = { color: code[0] as Color, type: code[1] as PieceType };
  }
  return {
    board,
    turn,
    castling: { wK: false, wQ: false, bK: false, bQ: false },
    ep: null,
    halfmove: 0,
    fullmove: 1,
    status: "PLAYING",
    ...over,
  };
}
const mv = (from: string, to: string, extra: Partial<ChessMove> = {}): ChessMove => ({
  from: nameSq(from),
  to: nameSq(to),
  ...extra,
});
const has = (moves: ChessMove[], m: ChessMove) => moves.some((x) => movesEqual(x, m));

describe("Chess engine", () => {
  it("square-name round trip", () => {
    expect(sqName(nameSq("e4"))).toBe("e4");
    expect(sqName([0, 0])).toBe("a8");
    expect(sqName([7, 7])).toBe("h1");
  });

  it("opening position has 20 legal moves for White", () => {
    expect(legalMoves(newChessGame()).length).toBe(20);
  });

  it("pawn double-push only from the start rank", () => {
    const g = newChessGame();
    expect(has(legalMoves(g), mv("e2", "e4"))).toBe(true);
    const after = applyMove(g, mv("e2", "e4"));
    expect(after.ep).toEqual(nameSq("e3")); // en-passant target set
    expect(after.turn).toBe("b");
  });

  it("Fool's mate is detected as CHECKMATE", () => {
    let g = newChessGame();
    g = applyMove(g, mv("f2", "f3"));
    g = applyMove(g, mv("e7", "e5"));
    g = applyMove(g, mv("g2", "g4"));
    g = applyMove(g, mv("d8", "h4")); // Qh4#
    expect(g.status).toBe("CHECKMATE");
    expect(legalMoves(g).length).toBe(0);
    expect(inCheck(g.board, "w")).toBe(true);
  });

  it("detects stalemate (not in check, no legal move)", () => {
    // White to move plays Qb6, stalemating the lone Black king on a8.
    const s = makeState({ a8: "bk", a6: "wk", e6: "wq" }, "w");
    const after = applyMove(s, mv("e6", "b6"));
    expect(after.turn).toBe("b");
    expect(inCheck(after.board, "b")).toBe(false);
    expect(legalMoves(after).length).toBe(0);
    expect(after.status).toBe("STALEMATE");
  });

  it("king may not move into check; must escape when checked", () => {
    // Black rook on e8 pins the file; White king e1 cannot stay/step into e-file.
    const s = makeState({ e1: "wk", e8: "br", a1: "wr" }, "w");
    const moves = legalMoves(s);
    expect(has(moves, mv("e1", "e2"))).toBe(false); // still on the checked file
    expect(has(moves, mv("e1", "d1"))).toBe(true); // steps off the file
    expect(has(moves, mv("e1", "f1"))).toBe(true);
  });

  it("kingside castling — legal only through safe, empty squares", () => {
    const s = makeState({ e1: "wk", h1: "wr", e8: "bk" }, "w", {
      castling: { wK: true, wQ: false, bK: false, bQ: false },
    });
    const castle = mv("e1", "g1", { castle: "K" });
    expect(has(legalMoves(s), castle)).toBe(true);
    const after = applyMove(s, castle);
    expect(after.board[7]![6]).toEqual({ color: "w", type: "k" }); // king g1
    expect(after.board[7]![5]).toEqual({ color: "w", type: "r" }); // rook f1
    expect(after.castling.wK).toBe(false);

    // A rook attacking f1 blocks castling (king passes through check).
    const blocked = makeState({ e1: "wk", h1: "wr", e8: "bk", f8: "br" }, "w", {
      castling: { wK: true, wQ: false, bK: false, bQ: false },
    });
    expect(has(legalMoves(blocked), castle)).toBe(false);
  });

  it("en passant captures the passed pawn", () => {
    // White pawn e5, Black plays d7-d5; White e5xd6 e.p. removes the d5 pawn.
    let s = makeState({ e5: "wp", d7: "bp", e1: "wk", e8: "bk" }, "b");
    s = applyMove(s, mv("d7", "d5"));
    expect(s.ep).toEqual(nameSq("d6"));
    const ep = mv("e5", "d6");
    expect(has(legalMoves(s), ep)).toBe(true);
    const after = applyMove(s, ep);
    expect(after.board[nameSq("d6")[0]]![nameSq("d6")[1]]).toEqual({ color: "w", type: "p" });
    expect(after.board[nameSq("d5")[0]]![nameSq("d5")[1]]).toBeNull(); // captured pawn gone
  });

  it("pawn promotion generates all four pieces and applies the chosen one", () => {
    const s = makeState({ a7: "wp", e1: "wk", e8: "bk" }, "w");
    const promos = legalMoves(s).filter((m) => sqName(m.from) === "a7" && sqName(m.to) === "a8");
    expect(promos.map((m) => m.promotion).sort()).toEqual(["b", "n", "q", "r"]);
    const after = applyMove(s, mv("a7", "a8", { promotion: "q" }));
    expect(after.board[0]![0]).toEqual({ color: "w", type: "q" });
  });

  it("insufficient material is a draw (K vs K, K+minor vs K, same-colour bishops)", () => {
    expect(insufficientMaterial(makeState({ e1: "wk", e8: "bk" }, "w").board)).toBe(true);
    expect(insufficientMaterial(makeState({ e1: "wk", e8: "bk", b1: "wn" }, "w").board)).toBe(true);
    expect(insufficientMaterial(makeState({ e1: "wk", e8: "bk", c1: "wb", f8: "bb" }, "w").board)).toBe(true); // c1,f8 both light
    expect(insufficientMaterial(makeState({ e1: "wk", e8: "bk", d1: "wq" }, "w").board)).toBe(false);
  });

  it("rejects an illegal move", () => {
    expect(() => applyMove(newChessGame(), mv("e2", "e5"))).toThrow();
  });

  it("threefold repetition is a draw (knight shuffle back to the start twice)", () => {
    // Each 4-ply shuffle returns to the starting position: counted at game
    // start (1), after the first shuffle (2), after the second (3) → DRAW.
    const shuffle = [mv("g1", "f3"), mv("g8", "f6"), mv("f3", "g1"), mv("f6", "g8")];
    let g = newChessGame();
    for (const m of shuffle) g = applyMove(g, m);
    expect(g.status).toBe("PLAYING"); // 2nd occurrence — not yet a draw
    for (const m of shuffle.slice(0, 3)) g = applyMove(g, m);
    expect(g.status).toBe("PLAYING");
    g = applyMove(g, shuffle[3]!);
    expect(g.status).toBe("DRAW"); // 3rd occurrence
    expect(legalMoves(g).length).toBe(0); // terminal — no moves offered
  });

  it("an irreversible move (pawn push / capture) resets repetition counting", () => {
    const shuffle = [mv("g1", "f3"), mv("g8", "f6"), mv("f3", "g1"), mv("f6", "g8")];
    let g = newChessGame();
    for (const m of shuffle) g = applyMove(g, m); // start position ×2
    g = applyMove(g, mv("e2", "e4")); // pawn push — nothing before can recur
    expect(g.status).toBe("PLAYING");
    expect(Object.keys(g.repetition!)).toEqual([positionKey(g)]);
    expect(g.repetition![positionKey(g)]).toBe(1);
  });

  it("tolerates legacy states persisted without a repetition map", () => {
    const s = makeState({ e1: "wk", a1: "wr", e8: "bk" }, "w"); // no `repetition`
    const after = applyMove(s, mv("a1", "a2"));
    expect(after.status).toBe("PLAYING");
    expect(after.repetition![positionKey(after)]).toBe(1); // counting starts now
  });
});
