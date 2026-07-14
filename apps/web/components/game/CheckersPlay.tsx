"use client";

// Checkers play surface: an interactive 8x8 board. The server sends the board
// plus the current player's LEGAL MOVES; the client is display-only — it just
// lets you pick a piece and one of its legal destinations, then POSTs the move.
// Perfect-information game, so nothing is hidden. Screen polls for the opponent.

import type { CheckersGameDto, Serialized } from "@sms/types";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { BoardClocks, StatusLine, liveClockMs, postSms, useNowTick, usePolled } from "./play-ui";

type Game = Serialized<CheckersGameDto>;
// Serialized<> flattens the [number,number] tuples to number[], so compare loosely.
type Sq = number[];
type Move = Game["legalMoves"][number];
const eq = (a: Sq, b: Sq) => a[0] === b[0] && a[1] === b[1];
const last = (m: Move): Sq => m.path[m.path.length - 1]!;

export function CheckersPlay({ initial }: { initial: Game }) {
  const { data: g, refresh } = usePolled<Game>(`checkers/${initial.id}`, initial, {
    intervalMs: 1500,
    stop: (d) => d.status === "FINISHED",
  });
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);
  const [selected, setSelected] = React.useState<Sq | null>(null);

  // Claim button appears once the opponent's live clock hits zero on their turn.
  const now = useNowTick(500);
  const curStored = g.turn === "b" ? g.blackTimeMs : g.whiteTimeMs;
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

  // Destinations (landing squares) of the currently-selected piece's legal moves.
  const movesFromSelected = selected ? g.legalMoves.filter((m) => eq(m.from, selected)) : [];
  const isDestination = (sq: Sq) => movesFromSelected.find((m) => eq(last(m), sq));
  const hasMoveFrom = (sq: Sq) => g.legalMoves.some((m) => eq(m.from, sq));

  const onSquare = async (r: number, c: number) => {
    if (!g.yourTurn) return;
    const sq: Sq = [r, c];
    const dest = selected ? isDestination(sq) : null;
    if (dest) {
      setSelected(null);
      await act(() => postSms(`checkers/${g.id}/move`, { from: dest.from, path: dest.path, captured: dest.captured }));
      return;
    }
    // Select one of your own movable pieces.
    if (hasMoveFrom(sq)) setSelected(sq);
    else setSelected(null);
  };

  const youWon = g.status === "FINISHED" && g.winnerUserId && g.yourColor &&
    ((g.yourColor === "b" && g.winnerUserId === g.black.userId) ||
      (g.yourColor === "w" && g.white && g.winnerUserId === g.white.userId));

  const turnLabel = g.turn === "b" ? g.black.displayName : g.white?.displayName ?? "White";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Checkers</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              ● {g.black.displayName} (black) vs ○ {g.white?.displayName ?? "waiting…"} (white)
            </p>
          </div>
          <Badge variant={g.status === "ACTIVE" ? "default" : "secondary"}>{g.status}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {g.status !== "LOBBY" && (
            <BoardClocks
              difficulty={g.difficulty}
              players={[
                ["b", `● ${g.black.displayName}`, g.blackTimeMs],
                ["w", `○ ${g.white?.displayName ?? "waiting…"}`, g.whiteTimeMs],
              ]}
              turn={g.turn}
              turnStartedAt={g.turnStartedAt}
              finished={g.status === "FINISHED"}
            />
          )}
          {g.status === "ACTIVE" && (
            <p className="text-sm">
              {g.yourTurn ? (
                <span className="font-medium text-primary">Your move.</span>
              ) : (
                <span className="text-muted-foreground">Waiting for {turnLabel}…</span>
              )}
            </p>
          )}
          {g.status === "LOBBY" && (
            <div className="flex flex-wrap items-center gap-2">
              {g.yourColor === "b" && <p className="text-sm text-muted-foreground">Waiting for an opponent to join…</p>}
              {!g.yourColor && (
                <Button onClick={() => act(() => postSms(`checkers/${g.id}/join`))}>Join game</Button>
              )}
            </div>
          )}
          {g.status === "FINISHED" && (
            <p className={cn("text-sm font-medium", youWon ? "text-brand2" : "text-muted-foreground")}>
              {g.outcome === "RESIGN" ? "Resigned. " : ""}
              {youWon ? "You won! 🎉" : g.yourColor ? "You lost." : "Game over."}
            </p>
          )}

          {/* Board */}
          <div className="inline-grid grid-cols-8 overflow-hidden rounded-md border border-border">
            {g.board.map((row, r) =>
              row.map((cell, c) => {
                const dark = (r + c) % 2 === 1;
                const sq: Sq = [r, c];
                const selectable = g.yourTurn && dark && hasMoveFrom(sq);
                const isSel = selected && eq(selected, sq);
                const dest = selected && dark ? isDestination(sq) : null;
                return (
                  <button
                    key={`${r}-${c}`}
                    type="button"
                    disabled={!dark || !g.yourTurn}
                    onClick={() => onSquare(r, c)}
                    className={cn(
                      "relative grid h-9 w-9 place-items-center sm:h-11 sm:w-11",
                      dark ? "bg-[hsl(28_25%_38%)]" : "bg-[hsl(36_38%_82%)]",
                      selectable && "cursor-pointer",
                      isSel && "ring-2 ring-inset ring-primary",
                    )}
                  >
                    {cell && (
                      <span
                        className={cn(
                          "grid h-6 w-6 place-items-center rounded-full text-[10px] font-bold shadow sm:h-8 sm:w-8",
                          cell.color === "b" ? "bg-neutral-900 text-neutral-300" : "bg-neutral-100 text-neutral-500",
                        )}
                      >
                        {cell.king ? "♚" : ""}
                      </span>
                    )}
                    {dest && <span aria-hidden className="absolute h-2.5 w-2.5 rounded-full bg-brand2/80" />}
                  </button>
                );
              }),
            )}
          </div>

          <StatusLine msg={msg} error={err} />

          <div className="flex flex-wrap gap-2">
            {oppFlagged && (
              <Button size="sm" onClick={() => act(() => postSms(`checkers/${g.id}/claim-time`))}>
                Claim win on time
              </Button>
            )}
            {g.status === "ACTIVE" && g.yourColor && (
              <Button variant="outline" size="sm" onClick={() => act(() => postSms(`checkers/${g.id}/resign`))}>
                Resign
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
