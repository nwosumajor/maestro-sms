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

  // Which questions are DONE. An objective question counts once a choice is
  // picked; a theory question once it holds non-blank text. (The old count used
  // `answers` alone, so a written theory answer never registered as answered.)
  const answeredIds = React.useMemo(() => {
    const done = new Set<string>();
    for (const q of s.questions) {
      if (q.type === "THEORY") {
        if ((s.theoryAnswers[q.id] ?? "").trim() !== "") done.add(q.id);
      } else if (s.answers[q.id] != null) {
        done.add(q.id);
      }
    }
    return done;
  }, [s.questions, s.answers, s.theoryAnswers]);
  const answered = answeredIds.size;
  const pending = s.questions.length - answered;

  // Jump to a question. All questions are on one page, so navigating is a scroll —
  // no request, no re-render of the paper, nothing to lose mid-exam.
  const cardRefs = React.useRef<Record<string, HTMLDivElement | null>>({});
  const jumpTo = (questionId: string) => {
    const el = cardRefs.current[questionId];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Focus the first control so a keyboard user lands ON the question.
    el.querySelector<HTMLElement>("input,textarea,button")?.focus({ preventScroll: true });
  };
  const firstPending = s.questions.find((q) => !answeredIds.has(q.id));

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

  // THEORY autosave. Debounced per question so typing doesn't post per keystroke,
  // and it writes ONE row server-side (not the whole answer blob).
  const timers = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const write = async (questionId: string, text: string) => {
    if (!open) return;
    setS((cur) => ({ ...cur, theoryAnswers: { ...cur.theoryAnswers, [questionId]: text } }));
    clearTimeout(timers.current[questionId]);
    timers.current[questionId] = setTimeout(async () => {
      const res = await fetch(`/api/sms/cbt/sittings/${s.sittingId}/answer-theory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, text }),
      });
      if (!res.ok) setMsg(await readApiError(res));
    }, 800);
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
              {open && pending > 0 && (
                <> · <span className="font-semibold text-amber-600 dark:text-amber-400">{pending} left</span></>
              )}
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
              {s.answersReleased
                ? "Correct answers are shown below. Your teacher reviews and releases official results."
                : "Correct answers will appear here once your teacher releases them and the principal approves."}
            </p>
          </CardContent>
        )}
      </Card>

      {/* QUESTION NAVIGATOR — the answered/pending map.
          Filled = answered, outlined = still to do. Tap a number to jump straight
          there, so nothing is left unanswered just because it was further down the
          page. Purely derived state: no request, and it can't disturb the paper. */}
      {open && (
        <Card>
          <CardContent className="space-y-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Your answers so far — tap a number to jump to that question.
              </p>
              {firstPending && (
                <button
                  type="button"
                  onClick={() => jumpTo(firstPending.id)}
                  className="text-xs font-medium text-primary underline"
                >
                  Go to first unanswered →
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {s.questions.map((q, i) => {
                const done = answeredIds.has(q.id);
                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => jumpTo(q.id)}
                    aria-label={`Question ${i + 1}: ${done ? "answered" : "not answered"}${q.type === "THEORY" ? " (theory)" : ""}`}
                    title={done ? `Question ${i + 1} — answered` : `Question ${i + 1} — not answered yet`}
                    className={cn(
                      "tnum grid h-8 w-8 place-items-center rounded-md border text-xs font-semibold transition-colors",
                      done
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-amber-500/60 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-400",
                      // Theory questions are visually distinct — they take longer,
                      // so a candidate can budget the remaining time.
                      q.type === "THEORY" && "rounded-full",
                    )}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
            <p className="text-[0.7rem] text-muted-foreground">
              Filled = answered · outlined = still to do{s.questions.some((q) => q.type === "THEORY") ? " · round = theory (written answer)" : ""}
            </p>
          </CardContent>
        </Card>
      )}

      {s.questions.map((q, i) => {
        const mine = s.answers[q.id];
        const done = answeredIds.has(q.id);
        // Section header: the paper is ordered Section A (objective) then
        // Section B (theory), so the boundary is the first theory question.
        const startsTheory = q.type === "THEORY" && (i === 0 || s.questions[i - 1]?.type !== "THEORY");
        const startsObjective = i === 0 && q.type !== "THEORY";
        return (
          <React.Fragment key={q.id}>
            {startsObjective && s.questions.some((x) => x.type === "THEORY") && (
              <h2 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Section A — Objective
              </h2>
            )}
            {startsTheory && (
              <h2 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Section B — Theory (written answers)
              </h2>
            )}
          <Card ref={(el) => { cardRefs.current[q.id] = el; }} className={cn(open && !done && "border-amber-500/40")}>
            <CardContent className="space-y-3 p-4">
              <p className="text-sm font-medium">
                <span className="mr-2 text-muted-foreground">{i + 1}.</span>
                {q.prompt}
                {open && !done && (
                  <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase text-amber-700 dark:text-amber-400">
                    not answered
                  </span>
                )}
              </p>
              {q.type === "THEORY" ? (
                <div className="space-y-1">
                  <textarea
                    className="min-h-[9rem] w-full rounded-md border border-input bg-background p-2 text-sm"
                    value={s.theoryAnswers[q.id] ?? ""}
                    onChange={(e) => void write(q.id, e.target.value)}
                    disabled={!open}
                    placeholder="Write your answer…"
                    aria-label={`Answer for question ${i + 1}`}
                  />
                  <p className="text-xs text-muted-foreground">
                    {q.maxMarks} mark{q.maxMarks === 1 ? "" : "s"} · saved as you type · marked by your teacher
                  </p>
                </div>
              ) : (
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
              )}
            </CardContent>
          </Card>
          </React.Fragment>
        );
      })}

      {msg && <p className="text-sm text-destructive">{msg}</p>}
      {open && (
        <div className="sticky bottom-4 flex justify-end">
          <Button
            size="lg"
            disabled={busy}
            onClick={() => {
              // A last check before the paper closes — easy to miss one on a long
              // page, and after submitting there is no way back.
              if (
                pending > 0 &&
                !window.confirm(
                  `${pending} question${pending === 1 ? "" : "s"} still unanswered. Submit anyway?`,
                )
              ) {
                if (firstPending) jumpTo(firstPending.id);
                return;
              }
              void submit();
            }}
            className="shadow-pop"
          >
            {busy ? "Submitting…" : `Submit (${answered}/${s.questions.length} answered)`}
          </Button>
        </div>
      )}
    </div>
  );
}
