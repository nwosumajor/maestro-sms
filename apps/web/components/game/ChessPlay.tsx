"use client";

// Chess play surface: an interactive 8x8 board. The server sends the board plus
// the current player's LEGAL MOVES (incl. castling + the four promotion options);
// the client is display-only — pick a piece, pick a legal destination, and (for a
// pawn reaching the last rank) pick the promotion piece. Screen polls the opponent.

import type { ChessGameDto, Serialized } from "@sms/types";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { BoardClocks, StatusLine, liveClockMs, postSms, useNowTick, usePolled } from "./play-ui";

type Game = Serialized<ChessGameDto>;
type Sq = number[];
type Move = Game["legalMoves"][number];
const eq = (a: Sq, b: Sq) => a[0] === b[0] && a[1] === b[1];

// Unicode glyphs: white then black, keyed by piece type.
const GLYPH: Record<string, [string, string]> = {
  p: ["♙", "♟"], n: ["♘", "♞"], b: ["♗", "♝"], r: ["♖", "♜"], q: ["♕", "♛"], k: ["♔", "♚"],
};
const PROMO: Array<["q" | "r" | "b" | "n", string]> = [["q", "Queen"], ["r", "Rook"], ["b", "Bishop"], ["n", "Knight"]];

export function ChessPlay({ initial }: { initial: Game }) {
  const { data: g, refresh } = usePolled<Game>(`chess/${initial.id}`, initial, {
    intervalMs: 1500,
    stop: (d) => d.status === "FINISHED",
  });
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);
  const [selected, setSelected] = React.useState<Sq | null>(null);
  const [promote, setPromote] = React.useState<{ moves: Move[] } | null>(null);

  const now = useNowTick(500);
  const curStored = g.turn === "w" ? g.whiteTimeMs : g.blackTimeMs;
  const oppFlagged =
    g.status === "ACTIVE" && !!g.yourColor && g.turn !== g.yourColor &&
    liveClockMs(curStored, true, g.turnStartedAt, now) <= 0;

  const act = async (fn: () => ReturnType<typeof postSms>) => {
    setMsg(null);
    setErr(false);
    const r = await fn();
    if (!r.ok) {
      setErr(true);
      setMsg(r.error ?? `Failed (${r.status}).`);
    }
    await refresh();
  };

  const submit = (m: Move) =>
    act(() => postSms(`chess/${g.id}/move`, { from: m.from, to: m.to, promotion: m.promotion, castle: m.castle }));

  const movesFromSelected = selected ? g.legalMoves.filter((m) => eq(m.from, selected)) : [];
  const destOf = (sq: Sq) => movesFromSelected.filter((m) => eq(m.to, sq));
  const hasMoveFrom = (sq: Sq) => g.legalMoves.some((m) => eq(m.from, sq));

  const onSquare = async (r: number, c: number) => {
    if (!g.yourTurn || promote) return;
    const sq: Sq = [r, c];
    if (selected) {
      const dests = destOf(sq);
      if (dests.length === 1) {
        setSelected(null);
        await submit(dests[0]!);
        return;
      }
      if (dests.length > 1) {
        // Same square reachable by 4 promotion variants → ask which piece.
        setSelected(null);
        setPromote({ moves: dests });
        return;
      }
    }
    if (hasMoveFrom(sq)) setSelected(sq);
    else setSelected(null);
  };

  const youWon = g.status === "FINISHED" && g.winnerUserId && g.yourColor &&
    ((g.yourColor === "w" && g.winnerUserId === g.white.userId) ||
      (g.yourColor === "b" && g.black && g.winnerUserId === g.black.userId));
  const turnLabel = g.turn === "w" ? g.white.displayName : g.black?.displayName ?? "Black";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Chess</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              ♔ {g.white.displayName} (white) vs ♚ {g.black?.displayName ?? "waiting…"} (black)
            </p>
          </div>
          <Badge variant={g.status === "ACTIVE" ? "default" : "secondary"}>{g.status}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {g.status !== "LOBBY" && (
            <BoardClocks
              difficulty={g.difficulty}
              players={[
                ["w", `♔ ${g.white.displayName}`, g.whiteTimeMs],
                ["b", `♚ ${g.black?.displayName ?? "waiting…"}`, g.blackTimeMs],
              ]}
              turn={g.turn}
              turnStartedAt={g.turnStartedAt}
              finished={g.status === "FINISHED"}
            />
          )}
          {g.status === "ACTIVE" && (
            <p className="text-sm">
              {g.chessStatus === "CHECK" && <span className="mr-2 font-semibold text-destructive">Check!</span>}
              {g.yourTurn ? (
                <span className="font-medium text-primary">Your move.</span>
              ) : (
                <span className="text-muted-foreground">Waiting for {turnLabel}…</span>
              )}
            </p>
          )}
          {g.status === "LOBBY" && (
            <div className="flex flex-wrap items-center gap-2">
              {g.yourColor === "w" && <p className="text-sm text-muted-foreground">Waiting for an opponent to join…</p>}
              {!g.yourColor && <Button onClick={() => act(() => postSms(`chess/${g.id}/join`))}>Join game</Button>}
            </div>
          )}
          {g.status === "FINISHED" && (
            <p className={cn("text-sm font-medium", youWon ? "text-brand2" : "text-muted-foreground")}>
              {g.outcome === "CHECKMATE" && "Checkmate. "}
              {g.outcome === "STALEMATE" && "Stalemate — draw. "}
              {g.outcome === "DRAW" && "Draw. "}
              {g.outcome === "RESIGN" && "Resigned. "}
              {youWon ? "You won! 🎉" : g.yourColor && g.winnerUserId ? "You lost." : "Game over."}
            </p>
          )}

          {/* Board */}
          <div className="relative inline-grid grid-cols-8 overflow-hidden rounded-md border border-border">
            {g.board.map((row, r) =>
              row.map((cell, c) => {
                const dark = (r + c) % 2 === 1;
                const sq: Sq = [r, c];
                const selectable = g.yourTurn && hasMoveFrom(sq);
                const isSel = selected && eq(selected, sq);
                const isDest = selected && destOf(sq).length > 0;
                return (
                  <button
                    key={`${r}-${c}`}
                    type="button"
                    disabled={!g.yourTurn}
                    onClick={() => onSquare(r, c)}
                    className={cn(
                      "relative grid h-9 w-9 place-items-center text-2xl leading-none sm:h-11 sm:w-11",
                      dark ? "bg-[hsl(28_25%_45%)]" : "bg-[hsl(36_38%_84%)]",
                      selectable && "cursor-pointer",
                      isSel && "ring-2 ring-inset ring-primary",
                    )}
                  >
                    {cell && (
                      <span className={cell.color === "w" ? "text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]" : "text-neutral-900"}>
                        {GLYPH[cell.type]?.[cell.color === "w" ? 0 : 1]}
                      </span>
                    )}
                    {isDest && <span aria-hidden className="absolute h-2.5 w-2.5 rounded-full bg-brand2/80" />}
                  </button>
                );
              }),
            )}
          </div>

          {/* Promotion picker */}
          {promote && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 p-3">
              <span className="text-sm font-medium">Promote to:</span>
              {PROMO.map(([piece, label]) => {
                const m = promote.moves.find((x) => x.promotion === piece);
                if (!m) return null;
                return (
                  <Button key={piece} size="sm" variant="outline" onClick={() => { setPromote(null); void submit(m); }}>
                    {label}
                  </Button>
                );
              })}
              <button type="button" onClick={() => setPromote(null)} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                Cancel
              </button>
            </div>
          )}

          <StatusLine msg={msg} error={err} />

          <div className="flex flex-wrap gap-2">
            {oppFlagged && (
              <Button size="sm" onClick={() => act(() => postSms(`chess/${g.id}/claim-time`))}>
                Claim win on time
              </Button>
            )}
            {g.status === "ACTIVE" && g.yourColor && (
              <Button variant="outline" size="sm" onClick={() => act(() => postSms(`chess/${g.id}/resign`))}>
                Resign
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
