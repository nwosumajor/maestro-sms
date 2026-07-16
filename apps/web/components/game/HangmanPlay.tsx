"use client";

// Hangman play surface. Each player works their OWN board of a shared server-only
// word: reveal it letter by letter before the lives run out. The word is hidden
// while live (only the masked form is shown) and revealed when the round ends.
// The host starts/ends; players tap letters. Screen stays fresh by polling.

import type { HangmanGameDto, Serialized } from "@sms/types";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Celebrate, StatusLine, postSms, useCelebratable, usePolled } from "./play-ui";

type Game = Serialized<HangmanGameDto>;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function HangmanPlay({ initial }: { initial: Game }) {
  const { data: g, refresh } = usePolled<Game>(`hangman/${initial.id}`, initial, {
    intervalMs: 1500,
    stop: (d) => d.status === "FINISHED",
  });
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);
  const [pending, setPending] = React.useState<string | null>(null);
  const celebratable = useCelebratable(initial.you?.status === "WON");

  const isHost = g.isHost;
  const you = g.you;
  const joined = !!you;
  const canGuess = g.status === "ACTIVE" && joined && you?.status === "PLAYING";
  const guessedSet = new Set(you?.guessed ?? []);
  const masked = you?.masked ?? "_".repeat(g.wordLength);

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

  const guess = async (letter: string) => {
    if (!canGuess || guessedSet.has(letter) || pending) return;
    setPending(letter);
    await act(() => postSms(`hangman/${g.id}/guess`, { letter }));
    setPending(null);
  };

  // A guessed letter that shows in the mask was a hit; otherwise a miss.
  const isHit = (l: string) => guessedSet.has(l) && masked.includes(l);
  const isMiss = (l: string) => guessedSet.has(l) && !masked.includes(l);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Hangman</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {g.difficulty.toLowerCase()} · {g.participantCount} playing
            </p>
          </div>
          <Badge variant={g.status === "ACTIVE" ? "default" : "secondary"}>{g.status}</Badge>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Masked word */}
          <div className="flex flex-wrap justify-center gap-1.5 py-2">
            {masked.split("").map((ch, i) => (
              <span
                key={i}
                className={cn(
                  "grid h-11 w-9 place-items-center rounded-md border text-xl font-semibold",
                  ch === "_" ? "border-border text-transparent" : "border-primary/40 bg-primary/5",
                )}
              >
                {ch === "_" ? "•" : ch}
              </span>
            ))}
          </div>

          {/* Lives */}
          {joined && g.status !== "FINISHED" && (
            <p className="text-center text-sm text-muted-foreground">
              Lives: <span className="tnum font-semibold text-foreground">{you?.livesRemaining}</span> / {g.lives}
            </p>
          )}

          {/* Lobby controls */}
          {g.status === "LOBBY" && (
            <div className="flex flex-wrap justify-center gap-2">
              {!joined && !isHost && (
                <Button onClick={() => act(() => postSms(`hangman/${g.id}/join`))}>Join round</Button>
              )}
              {joined && !isHost && <p className="text-sm text-muted-foreground">Waiting for the host to start…</p>}
              {isHost && (
                <Button onClick={() => act(() => postSms(`hangman/${g.id}/start`))}>Start round</Button>
              )}
            </div>
          )}

          {/* Letter keyboard */}
          {g.status === "ACTIVE" && joined && (
            <div className="mx-auto grid max-w-md grid-cols-7 gap-1.5 sm:grid-cols-9">
              {LETTERS.map((l) => (
                <button
                  key={l}
                  type="button"
                  disabled={!canGuess || guessedSet.has(l) || !!pending}
                  onClick={() => guess(l)}
                  className={cn(
                    "grid h-9 place-items-center rounded-md border text-sm font-medium transition-colors",
                    !guessedSet.has(l) && canGuess && "border-border hover:border-primary hover:bg-primary/5",
                    isHit(l) && "border-brand2/50 bg-brand2/10 text-brand2",
                    isMiss(l) && "border-border text-muted-foreground line-through opacity-50",
                    !guessedSet.has(l) && !canGuess && "border-border opacity-40",
                  )}
                >
                  {l}
                </button>
              ))}
            </div>
          )}

          {/* Player outcome */}
          {you?.status === "WON" && (
            <p className="animate-pop-in rounded-md border border-brand2/50 bg-brand2/10 p-3 text-center text-sm font-medium">
              {you.rank && you.rank <= 3 ? "🏆" : "✅"} Solved it{you.rank ? ` — placed #${you.rank}!` : "!"}
              {you.rank === 1 && celebratable && <Celebrate />}
            </p>
          )}
          {you?.status === "LOST" && (
            <p className="rounded-md border border-border bg-muted/50 p-3 text-center text-sm text-muted-foreground">
              Out of lives.{g.word ? ` The word was ${g.word}.` : " Better luck next round!"}
            </p>
          )}
          {g.status === "FINISHED" && g.word && (
            <p className="text-center text-sm text-muted-foreground">
              The word was <span className="font-semibold text-foreground">{g.word}</span>.
            </p>
          )}
          {!joined && g.status === "ACTIVE" && (
            <p className="text-center text-sm text-muted-foreground">This round is underway; joining is closed.</p>
          )}

          <StatusLine msg={msg} error={err} />

          {isHost && g.status !== "FINISHED" && (
            <div className="text-center">
              <Button variant="outline" size="sm" onClick={() => act(() => postSms(`hangman/${g.id}/end`))}>
                End round (host)
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Leaderboard</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {g.leaderboard.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No solvers yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {g.leaderboard.map((f) => (
                  <tr key={f.userId} className={cn("border-b border-border last:border-0", f.rank <= 3 && "font-medium")}>
                    <td className="w-10 px-4 py-2.5 text-muted-foreground">
                      {f.rank <= 3 ? ["🥇", "🥈", "🥉"][f.rank - 1] : `#${f.rank}`}
                    </td>
                    <td className="px-4 py-2.5">{f.displayName}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">
                      {f.wrong} wrong guess{f.wrong === 1 ? "" : "es"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
