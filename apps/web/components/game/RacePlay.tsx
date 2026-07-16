"use client";

// Class Race play surface (spec §5, step 5). One shared server-only target; all
// racers crack it in PARALLEL (no turns). First three to crack win. A racer sees
// only their own guesses; the leaderboard shows finishers by display name.

import type { RaceDto, Serialized } from "@sms/types";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Celebrate, GuessForm, GuessList, LiveDot, StatusLine, postSms, useCelebratable, useLiveGame } from "./play-ui";

type Race = Serialized<RaceDto>;

export function RacePlay({ initial, canOpen }: { initial: Race; canOpen: boolean }) {
  const { data: race, refresh, live } = useLiveGame<Race>(initial.id, `races/${initial.id}`, initial, {
    mode: "race",
    fallbackMs: 2000,
    stop: (r) => r.status === "FINISHED" || r.status === "ABANDONED",
  });
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);
  const celebratable = useCelebratable(!!initial.yourFinish);

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

  const joined = !!race.you;
  const finished = !!race.yourFinish;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Class Race</CardTitle>
          <div className="flex items-center gap-2">
            <LiveDot live={live} />
            <Badge variant={race.status === "ACTIVE" ? "default" : "secondary"}>{race.status}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Everyone races to crack the same {race.difficultyLength}-digit target. Fewest guesses wins;
            the first three finishers take the podium. {race.participantCount} racing.
          </p>

          {race.status === "LOBBY" && (
            <div className="flex flex-wrap gap-2">
              {!joined && (
                <Button onClick={() => act(() => postSms(`races/${race.id}/join`))}>Join race</Button>
              )}
              {joined && !canOpen && (
                <p className="text-sm text-muted-foreground">You&apos;re in. Waiting for the teacher to start…</p>
              )}
              {canOpen && (
                <Button onClick={() => act(() => postSms(`races/${race.id}/start`))}>Start race</Button>
              )}
            </div>
          )}

          {race.status === "ACTIVE" && joined && !finished && (
            <GuessForm
              length={race.difficultyLength}
              onSubmit={(value) => act(() => postSms(`races/${race.id}/guess`, { value }))}
            />
          )}

          {race.status === "ACTIVE" && joined && finished && race.yourFinish && (
            <div className="animate-pop-in rounded-md border border-brand2/50 bg-brand2/10 p-4">
              {race.yourFinish.rank <= 3 && celebratable && <Celebrate />}
              <p className="font-semibold">
                {race.yourFinish.rank <= 3 ? "🏆" : "✅"} Cracked it in {race.yourFinish.guessCount} guesses — placed #{race.yourFinish.rank}!
              </p>
            </div>
          )}

          {race.status === "ACTIVE" && !joined && (
            <p className="text-sm text-muted-foreground">This race is underway and joining is closed.</p>
          )}

          {race.status === "FINISHED" && (
            <p className="text-sm text-muted-foreground">The race is over — final podium below.</p>
          )}

          <StatusLine msg={msg} error={err} />

          {canOpen && (race.status === "ACTIVE" || race.status === "LOBBY") && (
            <Button variant="outline" size="sm" onClick={() => act(() => postSms(`races/${race.id}/end`))}>
              End race (teacher)
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Leaderboard</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {race.leaderboard.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No finishers yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {race.leaderboard.map((f) => (
                  <tr key={f.userId} className={cn("border-b border-border last:border-0", f.rank <= 3 && "font-medium")}>
                    <td className="px-4 py-2.5 w-10 text-muted-foreground">
                      {f.rank <= 3 ? ["🥇", "🥈", "🥉"][f.rank - 1] : `#${f.rank}`}
                    </td>
                    <td className="px-4 py-2.5">{f.displayName}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">
                      {f.guessCount} guesses · {(f.elapsedMs / 1000).toFixed(1)}s
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {joined && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your guesses</CardTitle>
          </CardHeader>
          <CardContent>
            <GuessList guesses={race.yourGuesses} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
