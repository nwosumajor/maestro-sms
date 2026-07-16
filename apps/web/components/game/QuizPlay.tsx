"use client";

// Live Quiz play surface (Kahoot-style). The HOST drives the session (Next
// question / End); PLAYERS join and tap an answer against a countdown. The
// server is authoritative: a live question's correct answer is not present in
// the player view until it closes, and scoring is computed server-side. The
// screen keeps fresh by polling the BFF.

import type { LiveQuizSessionDto, Serialized } from "@sms/types";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Celebrate, StatusLine, postSms, useCelebratable, usePolled } from "./play-ui";

type Session = Serialized<LiveQuizSessionDto>;

/** The Kahoot answer grammar: colour + shape identify a choice faster than a
 *  letter can. Fixed per INDEX (game semantics, not tenant branding). */
const TILE = [
  { bg: "bg-red-500", shape: "▲" },
  { bg: "bg-blue-500", shape: "◆" },
  { bg: "bg-amber-500", shape: "●" },
  { bg: "bg-emerald-600", shape: "■" },
  { bg: "bg-violet-500", shape: "⬟" },
  { bg: "bg-sky-500", shape: "✚" },
] as const;

/** Live countdown from the question's server start + its time limit. */
function useCountdown(startedAt: string | null, limitSeconds: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  if (!startedAt) return limitSeconds;
  const end = new Date(startedAt).getTime() + limitSeconds * 1000;
  return Math.max(0, Math.ceil((end - now) / 1000));
}

/** Final top-three, laid out 2nd · 1st · 3rd with rising columns. */
function Podium({ rows }: { rows: Session["leaderboard"] }) {
  const top = [rows.find((r) => r.rank === 2), rows.find((r) => r.rank === 1), rows.find((r) => r.rank === 3)];
  const style = [
    { h: "h-16", medal: "🥈", delay: "0.15s" },
    { h: "h-24", medal: "🥇", delay: "0.3s" },
    { h: "h-12", medal: "🥉", delay: "0s" },
  ];
  if (!top[1]) return null;
  return (
    <div className="flex items-end justify-center gap-3 pt-2">
      {top.map((row, i) =>
        row ? (
          <div
            key={row.userId}
            className="flex w-24 animate-fade-up flex-col items-center gap-1.5 sm:w-28"
            style={{ animationDelay: style[i]!.delay }}
          >
            <span className="text-2xl" aria-hidden>
              {style[i]!.medal}
            </span>
            <span className="max-w-full truncate text-sm font-medium">{row.displayName}</span>
            <span className="tnum text-xs text-muted-foreground">{row.score}</span>
            <div
              className={cn(
                "w-full rounded-t-md border border-b-0 border-border",
                style[i]!.h,
                row.rank === 1 ? "bg-amber-500/25" : "bg-muted",
              )}
            />
          </div>
        ) : (
          <div key={`empty-${i}`} className="w-24 sm:w-28" />
        ),
      )}
    </div>
  );
}

export function QuizPlay({ initial }: { initial: Session }) {
  const { data: s, refresh } = usePolled<Session>(`quiz-sessions/${initial.id}`, initial, {
    intervalMs: 1500,
    stop: (d) => d.status === "ENDED",
  });
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);
  const [pending, setPending] = React.useState<number | null>(null);
  const celebratable = useCelebratable(initial.status === "ENDED");

  const q = s.question;
  const remaining = useCountdown(q?.startedAt ?? null, q?.timeLimitSeconds ?? 0);
  const isHost = s.isHost;
  const joined = !!s.you;
  const answered = !!s.you?.answeredCurrent;

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

  const answer = async (choiceIndex: number) => {
    if (answered || pending !== null) return;
    setPending(choiceIndex);
    await act(() => postSms(`quiz-sessions/${s.id}/answer`, { choiceIndex }));
    setPending(null);
  };

  const themeLabel = s.theme.charAt(0) + s.theme.slice(1).toLowerCase();
  const youTopped = s.status === "ENDED" && s.you?.rank === 1 && s.you.score > 0;
  const timePct = q && q.timeLimitSeconds > 0 ? Math.min(100, (remaining / q.timeLimitSeconds) * 100) : 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">{s.title}</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {themeLabel} · {s.difficulty.toLowerCase()} · {s.participantCount} playing
            </p>
          </div>
          <Badge variant={s.status === "ACTIVE" ? "default" : "secondary"}>{s.status}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Lobby */}
          {s.status === "LOBBY" && (
            <div className="flex flex-wrap items-center gap-2">
              {!joined && !isHost && (
                <Button onClick={() => act(() => postSms(`quiz-sessions/${s.id}/join`))}>Join quiz</Button>
              )}
              {joined && !isHost && (
                <p className="text-sm text-muted-foreground">You&apos;re in. Waiting for the host to start…</p>
              )}
              {isHost && (
                <Button onClick={() => act(() => postSms(`quiz-sessions/${s.id}/next`))}>
                  Start — first question
                </Button>
              )}
            </div>
          )}

          {/* Active question — keyed by index so each question pops in fresh. */}
          {s.status === "ACTIVE" && q && (
            <div key={q.index} className="animate-pop-in space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  Question {q.index + 1} of {s.questionCount}
                </span>
                <span
                  className={cn(
                    "tnum rounded-full px-2.5 py-0.5 text-xs font-semibold",
                    remaining <= 5 ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground",
                  )}
                >
                  {remaining}s
                </span>
              </div>
              {/* Time drains visibly, not just numerically. */}
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-[width] duration-500 ease-linear",
                    remaining <= 5 ? "bg-destructive" : "bg-primary",
                  )}
                  style={{ width: `${timePct}%` }}
                />
              </div>
              <p className="text-lg font-medium">{q.prompt}</p>

              <div className="grid gap-2.5 sm:grid-cols-2">
                {q.choices.map((choice, i) => {
                  // Reveal correctness once the answer is known (host always;
                  // players after the question closes — server-driven).
                  const tile = TILE[i % TILE.length]!;
                  const revealed = q.answerIndex !== null;
                  const isCorrect = revealed && i === q.answerIndex;
                  const isWrong = revealed && !isCorrect;
                  const canPick = !isHost && joined && !answered && !revealed;
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={!canPick}
                      onClick={() => answer(i)}
                      className={cn(
                        "flex min-h-14 items-center gap-3 rounded-lg px-4 py-3 text-left text-sm font-medium text-white shadow-card transition-all",
                        tile.bg,
                        canPick && "hover:brightness-110 active:scale-[0.99]",
                        !canPick && "cursor-default",
                        isCorrect && "ring-2 ring-white/80",
                        isWrong && "opacity-35 saturate-50",
                        pending === i && "ring-2 ring-white/60",
                      )}
                    >
                      <span aria-hidden className="text-lg leading-none drop-shadow-sm">
                        {tile.shape}
                      </span>
                      <span className="drop-shadow-sm">{choice}</span>
                      {isCorrect && (
                        <span className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/90 text-sm font-bold text-emerald-600">
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Player feedback */}
              {!isHost && joined && answered && (
                <div
                  className={cn(
                    "animate-fade-up rounded-md border p-3 text-sm",
                    s.you?.currentCorrect
                      ? "border-brand2/50 bg-brand2/10"
                      : "border-border bg-muted/50 text-muted-foreground",
                  )}
                >
                  {s.you?.currentCorrect
                    ? "✅ Correct! Waiting for the next question…"
                    : "Not this time — waiting for the next question…"}
                </div>
              )}
              {!isHost && !joined && (
                <p className="text-sm text-muted-foreground">This quiz is underway; joining is closed.</p>
              )}

              {/* Host controls */}
              {isHost && (
                <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                  <Button onClick={() => act(() => postSms(`quiz-sessions/${s.id}/next`))}>
                    {q.index + 1 >= s.questionCount ? "Finish quiz" : "Next question"}
                  </Button>
                  <Button variant="outline" onClick={() => act(() => postSms(`quiz-sessions/${s.id}/end`))}>
                    End quiz
                  </Button>
                </div>
              )}
            </div>
          )}

          {s.status === "ENDED" && (
            <div className="space-y-1">
              <Podium rows={s.leaderboard} />
              <p className="pt-2 text-center text-sm text-muted-foreground">
                {youTopped ? "🏆 Top of the class — well played!" : "The quiz has ended — final standings below."}
              </p>
              {youTopped && celebratable && <Celebrate />}
            </div>
          )}

          {s.you && (
            <p className="text-sm">
              Your score: <span className="tnum font-semibold">{s.you.score}</span>
              {s.you.streak > 1 && (
                <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-600">
                  🔥 {s.you.streak} streak
                </span>
              )}
            </p>
          )}

          <StatusLine msg={msg} error={err} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Leaderboard</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {s.leaderboard.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No scores yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {s.leaderboard.map((row) => (
                  <tr
                    key={row.userId}
                    className={cn(
                      "border-b border-border last:border-0",
                      row.rank <= 3 && "font-medium",
                    )}
                  >
                    <td className="w-10 px-4 py-2.5 text-muted-foreground">
                      {row.rank <= 3 ? ["🥇", "🥈", "🥉"][row.rank - 1] : `#${row.rank}`}
                    </td>
                    <td className="px-4 py-2.5">{row.displayName}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">
                      {row.correct} correct · <span className="tnum font-medium text-foreground">{row.score}</span>
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
