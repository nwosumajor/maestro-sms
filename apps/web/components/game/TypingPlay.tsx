"use client";

// Typing Race play surface. Each racer types the shared passage; the SERVER
// computes WPM/accuracy from the reported text (the client never self-reports
// speed). The passage is shown to everyone (not a secret). The typed text is
// posted on a throttle so the live leaderboard updates; the screen polls for
// others' progress.

import type { Serialized, TypingRaceDto } from "@sms/types";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { StatusLine, postSms, usePolled } from "./play-ui";

type Race = Serialized<TypingRaceDto>;

export function TypingPlay({ initial }: { initial: Race }) {
  const { data: race, refresh } = usePolled<Race>(`typing-races/${initial.id}`, initial, {
    intervalMs: 1500,
    stop: (d) => d.status === "FINISHED",
  });
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  // Throttle progress POSTs (>= 700ms apart), but always send the finishing one.
  const lastSent = React.useRef(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const isHost = race.isHost;
  const joined = !!race.you;
  const finished = !!race.you?.finished;
  const active = race.status === "ACTIVE";

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

  const sendProgress = React.useCallback(
    async (value: string) => {
      lastSent.current = Date.now();
      await postSms(`typing-races/${initial.id}/progress`, { typed: value });
      await refresh();
    },
    [initial.id, refresh],
  );

  const onType = (value: string) => {
    if (!active || finished) return;
    setTyped(value);
    // Fire immediately on completion; otherwise throttle to ~700ms.
    if (value === race.passage) {
      if (timer.current) clearTimeout(timer.current);
      void sendProgress(value);
      return;
    }
    const since = Date.now() - lastSent.current;
    if (timer.current) clearTimeout(timer.current);
    if (since >= 700) void sendProgress(value);
    else timer.current = setTimeout(() => void sendProgress(value), 700 - since);
  };

  React.useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Typing Race</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {race.difficulty.toLowerCase()} · target {race.targetWpm} wpm · {race.participantCount} racing
            </p>
          </div>
          <Badge variant={active ? "default" : "secondary"}>{race.status}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Passage with per-character correctness highlighting. */}
          <p className="rounded-lg border border-border bg-muted/30 p-4 font-mono text-[0.95rem] leading-relaxed">
            {race.passage.split("").map((ch, i) => {
              const done = i < typed.length;
              const correct = done && typed[i] === ch;
              const wrong = done && typed[i] !== ch;
              const cursor = i === typed.length && active && joined && !finished;
              return (
                <span
                  key={i}
                  className={cn(
                    correct && "text-brand2",
                    wrong && "rounded bg-destructive/20 text-destructive",
                    !done && "text-muted-foreground",
                    cursor && "border-b-2 border-primary",
                  )}
                >
                  {ch}
                </span>
              );
            })}
          </p>

          {race.you && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                Speed: <span className="tnum font-semibold">{Math.round(race.you.netWpm)}</span> wpm
              </span>
              <span>
                Accuracy: <span className="tnum font-semibold">{Math.round(race.you.accuracy * 100)}%</span>
              </span>
              {finished && race.you.rank && <span className="font-medium text-brand2">Finished #{race.you.rank} 🎉</span>}
            </div>
          )}

          {/* Lobby controls */}
          {race.status === "LOBBY" && (
            <div className="flex flex-wrap items-center gap-2">
              {!joined && !isHost && (
                <Button onClick={() => act(() => postSms(`typing-races/${race.id}/join`))}>Join race</Button>
              )}
              {joined && !isHost && <p className="text-sm text-muted-foreground">Waiting for the host to start…</p>}
              {isHost && (
                <Button onClick={() => act(() => postSms(`typing-races/${race.id}/start`))}>Start race</Button>
              )}
            </div>
          )}

          {/* Typing input */}
          {active && joined && !finished && (
            <textarea
              autoFocus
              value={typed}
              onChange={(e) => onType(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder="Start typing the passage above…"
              className="w-full rounded-md border border-input bg-background p-3 font-mono text-sm outline-none focus:border-primary"
            />
          )}
          {active && !joined && (
            <p className="text-sm text-muted-foreground">This race is underway; joining is closed.</p>
          )}

          <StatusLine msg={msg} error={err} />

          {isHost && race.status !== "FINISHED" && (
            <Button variant="outline" size="sm" onClick={() => act(() => postSms(`typing-races/${race.id}/end`))}>
              End race (host)
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
            <p className="px-4 py-4 text-sm text-muted-foreground">No racers yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {race.leaderboard.map((f) => {
                  const pct = race.passage.length ? Math.min(100, Math.round((f.progress / race.passage.length) * 100)) : 0;
                  return (
                    <tr key={f.userId} className={cn("border-b border-border last:border-0", f.rank <= 3 && f.finished && "font-medium")}>
                      <td className="w-10 px-4 py-2.5 text-muted-foreground">
                        {f.finished && f.rank <= 3 ? ["🥇", "🥈", "🥉"][f.rank - 1] : `#${f.rank}`}
                      </td>
                      <td className="px-4 py-2.5">
                        <div>{f.displayName}</div>
                        <div className="mt-1 h-1.5 w-full max-w-[12rem] overflow-hidden rounded-full bg-muted">
                          <div className={cn("h-full rounded-full", f.finished ? "bg-brand2" : "bg-primary")} style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">
                        <span className="tnum font-medium text-foreground">{Math.round(f.netWpm)}</span> wpm ·{" "}
                        {Math.round(f.accuracy * 100)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
