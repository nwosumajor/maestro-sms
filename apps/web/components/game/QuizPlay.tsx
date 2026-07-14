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
import { StatusLine, postSms, usePolled } from "./play-ui";

type Session = Serialized<LiveQuizSessionDto>;

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

export function QuizPlay({ initial }: { initial: Session }) {
  const { data: s, refresh } = usePolled<Session>(`quiz-sessions/${initial.id}`, initial, {
    intervalMs: 1500,
    stop: (d) => d.status === "ENDED",
  });
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);
  const [pending, setPending] = React.useState<number | null>(null);

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

          {/* Active question */}
          {s.status === "ACTIVE" && q && (
            <div className="space-y-4">
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
              <p className="text-lg font-medium">{q.prompt}</p>

              <div className="grid gap-2 sm:grid-cols-2">
                {q.choices.map((choice, i) => {
                  // Reveal correctness once the answer is known (host always;
                  // players after the question closes — server-driven).
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
                        "flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                        canPick && "hover:border-primary hover:bg-primary/5",
                        !canPick && "cursor-default",
                        isCorrect && "border-brand2/60 bg-brand2/10 font-medium",
                        isWrong && "border-border opacity-60",
                        !revealed && "border-border",
                        pending === i && "border-primary bg-primary/5",
                      )}
                    >
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-muted text-xs font-semibold">
                        {"ABCDEF"[i]}
                      </span>
                      <span>{choice}</span>
                      {isCorrect && <span className="ml-auto text-brand2">✓</span>}
                    </button>
                  );
                })}
              </div>

              {/* Player feedback */}
              {!isHost && joined && answered && (
                <div
                  className={cn(
                    "rounded-md border p-3 text-sm",
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
            <p className="text-sm text-muted-foreground">The quiz has ended — final standings below. 🎉</p>
          )}

          {s.you && (
            <p className="text-sm">
              Your score: <span className="tnum font-semibold">{s.you.score}</span>
              {s.you.streak > 1 && <span className="ml-2 text-brand2">🔥 {s.you.streak} streak</span>}
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
