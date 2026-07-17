"use client";

// The student's exam room: server-fixed question order, a countdown to the
// SERVER-computed deadline, answers saved as they're picked, and a submit that
// auto-marks. The answer key exists on this screen only after the sitting
// closes — the server withholds it until then.

import type { CbtSittingViewDto, Serialized } from "@sms/types";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { readApiError } from "@/lib/api-error";

type Sitting = Serialized<CbtSittingViewDto>;

function useCountdown(deadline: string): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((new Date(deadline).getTime() - now) / 1000));
}

export function CbtExamRoom({ initial }: { initial: Sitting }) {
  const [s, setS] = React.useState<Sitting>(initial);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const secondsLeft = useCountdown(s.deadline);
  const open = s.status === "IN_PROGRESS";
  const answered = Object.keys(s.answers).length;

  // Time's up → submit automatically (the server would refuse late answers anyway).
  const submittedRef = React.useRef(false);
  React.useEffect(() => {
    if (open && secondsLeft === 0 && !submittedRef.current) {
      submittedRef.current = true;
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reason: submit is stable within this component's lifetime.
  }, [secondsLeft, open]);

  const pick = async (questionId: string, choiceIndex: number) => {
    if (!open) return;
    // Optimistic: the local mark lands immediately; the server save follows.
    setS((cur) => ({ ...cur, answers: { ...cur.answers, [questionId]: choiceIndex } }));
    const res = await fetch(`/api/sms/cbt/sittings/${s.sittingId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId, choiceIndex }),
    });
    if (!res.ok) setMsg(await readApiError(res));
  };

  async function submit() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/sms/cbt/sittings/${s.sittingId}/submit`, { method: "POST" });
    setBusy(false);
    if (res.ok) setS((await res.json()) as Sitting);
    else setMsg(await readApiError(res));
  }

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">{s.examTitle}</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {s.questions.length} questions · {answered} answered
            </p>
          </div>
          {open ? (
            <span
              className={cn(
                "tnum rounded-full px-3 py-1 font-mono text-sm font-semibold",
                secondsLeft <= 120 ? "bg-destructive/15 text-destructive" : "bg-muted",
              )}
            >
              {mm}:{ss}
            </span>
          ) : (
            <Badge variant={s.status === "SUBMITTED" ? "secondary" : "destructive"}>{s.status}</Badge>
          )}
        </CardHeader>
        {!open && s.score != null && (
          <CardContent>
            <p className="animate-pop-in text-lg font-semibold">
              Score: <span className="tnum">{s.score} / {s.total}</span>
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Correct answers are shown below. Your teacher reviews and releases official results.
            </p>
          </CardContent>
        )}
      </Card>

      {s.questions.map((q, i) => {
        const mine = s.answers[q.id];
        return (
          <Card key={q.id}>
            <CardContent className="space-y-3 p-4">
              <p className="text-sm font-medium">
                <span className="mr-2 text-muted-foreground">{i + 1}.</span>
                {q.prompt}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {q.choices.map((choice, ci) => {
                  const picked = mine === ci;
                  const revealed = q.answerIndex != null;
                  const correct = revealed && ci === q.answerIndex;
                  const wrongPick = revealed && picked && !correct;
                  return (
                    <button
                      key={ci}
                      type="button"
                      disabled={!open}
                      onClick={() => pick(q.id, ci)}
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        open && "hover:border-primary hover:bg-primary/5",
                        picked && !revealed && "border-primary bg-primary/10 font-medium",
                        correct && "border-brand2/60 bg-brand2/10 font-medium",
                        wrongPick && "border-destructive/60 bg-destructive/10",
                        !picked && !correct && !wrongPick && "border-border",
                        !open && "cursor-default",
                      )}
                    >
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-muted text-xs font-semibold">
                        {"ABCDEF"[ci]}
                      </span>
                      <span>{choice}</span>
                      {correct && <span className="ml-auto text-brand2">✓</span>}
                      {wrongPick && <span className="ml-auto text-destructive">✗</span>}
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}

      {msg && <p className="text-sm text-destructive">{msg}</p>}
      {open && (
        <div className="sticky bottom-4 flex justify-end">
          <Button size="lg" disabled={busy} onClick={submit} className="shadow-pop">
            {busy ? "Submitting…" : `Submit (${answered}/${s.questions.length} answered)`}
          </Button>
        </div>
      )}
    </div>
  );
}
