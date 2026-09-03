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

/**
 * Is this a question whose options fit two to a row?
 *
 * A CANDIDATE MUST BE ABLE TO READ THE WHOLE OPTION. Two columns are right for
 * "3 / 4 / 5" and wrong for a sentence: at half width a long option had nowhere
 * to go, and the text span carried no `min-w-0`, so it overflowed its own button
 * instead of wrapping. So the PAPER decides the layout — one column the moment
 * any option is long — rather than the layout deciding what a paper may say.
 */
const SHORT_OPTION_CHARS = 40;
export function shortOptions(choices: string[]): boolean {
  return choices.every((c) => c.length <= SHORT_OPTION_CHARS);
}

function useCountdown(deadline: string): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((new Date(deadline).getTime() - now) / 1000));
}

/**
 * The clock, and ONLY the clock.
 *
 * `secondsLeft` used to be state on the exam room itself — the component that
 * renders every question and every option — so a paper of 40 questions and 160
 * option buttons re-rendered ONCE A SECOND for the whole sitting, on whatever
 * machine the school has. Nothing about the paper changes between ticks.
 *
 * Isolated here, a tick repaints the digits and nothing else. The expiry is
 * reported UPWARDS once, so the parent still auto-submits without holding a
 * per-second value of its own.
 */
function ExamClock({
  deadline,
  onExpired,
  className,
}: {
  deadline: string;
  onExpired: () => void;
  className?: string;
}) {
  const secondsLeft = useCountdown(deadline);
  const firedRef = React.useRef(false);
  React.useEffect(() => {
    if (secondsLeft === 0 && !firedRef.current) {
      firedRef.current = true;
      onExpired();
    }
  }, [secondsLeft, onExpired]);
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");
  return (
    <span
      role="timer"
      aria-label={`Time remaining: ${mm} minutes ${ss} seconds`}
      className={cn(
        "tnum rounded-full px-3 py-1 font-mono text-sm font-semibold",
        secondsLeft <= 120 ? "bg-destructive/15 text-destructive" : "bg-muted",
        className,
      )}
    >
      {mm}:{ss}
    </span>
  );
}

export function CbtExamRoom({
  initial,
  basePath = "cbt",
}: {
  initial: Sitting;
  /**
   * Which surface this sitting is served from — `cbt` for a school's own exam,
   * `scholarships` for a platform scholarship.
   *
   * ONE exam room, two doors. `/cbt/*` is gated on the PREMIUM CBT module, so a
   * scholarship candidate at a STANDARD school could not reach it; the
   * scholarship surface is always-on and carries the same four sitting routes.
   * A second copy of this screen is how the two would start behaving
   * differently for the same candidate.
   */
  basePath?: "cbt" | "scholarships";
}) {
  const [s, setS] = React.useState<Sitting>(initial);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
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
    // CLOSE THE MAP ON THE WAY. Leaving a hundred numbers open over the
    // question you just jumped to defeats the jump.
    if (s.questions.length > 12) setMapOpen(false);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Focus the first control so a keyboard user lands ON the question.
    el.querySelector<HTMLElement>("input,textarea,button")?.focus({ preventScroll: true });
  };
  const firstPending = s.questions.find((q) => !answeredIds.has(q.id));

  // --- exam integrity -------------------------------------------------------
  // Leaving the exam (switching tab, minimising, closing the app) is RECORDED and
  // shown to staff. It is deliberately visible to the candidate: monitoring minors
  // covertly is against this module's own policy, and a warning they can see is a
  // better deterrent than one they cannot.
  //
  // Nothing here penalises: no auto-submit, no mark change, no lock-out. The
  // server treats these as signals for a human to review (Golden Rule #8).
  const [integrity, setIntegrity] = React.useState({ focusLosses: 0, awayMs: 0 });
  const awaySince = React.useRef<number | null>(null);
  const queue = React.useRef<{ type: string; awayMs?: number; chars?: number }[]>([]);

  const flush = React.useCallback(async () => {
    if (queue.current.length === 0) return;
    const events = queue.current.splice(0, 25);
    const res = await fetch(`/api/sms/${basePath}/sittings/${s.sittingId}/integrity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });
    if (res.ok) {
      const r = (await res.json()) as { focusLosses: number; awayMs: number };
      setIntegrity({ focusLosses: r.focusLosses, awayMs: r.awayMs });
    }
  }, [s.sittingId]);

  React.useEffect(() => {
    if (!open) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        awaySince.current = Date.now();
      } else if (awaySince.current !== null) {
        const awayMs = Date.now() - awaySince.current;
        awaySince.current = null;
        // Ignore sub-second flickers (a click into the URL bar isn't cheating).
        if (awayMs >= 1000) {
          queue.current.push({ type: "FOCUS_LOSS", awayMs });
          void flush();
        }
      }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("blur", onHide);
    window.addEventListener("focus", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("blur", onHide);
      window.removeEventListener("focus", onHide);
    };
  }, [open, flush]);

  // Time's up → submit automatically (the server would refuse late answers
  // anyway). Driven by the CLOCK's own callback, so the paper no longer holds a
  // value that changes every second.
  const submittedRef = React.useRef(false);
  const onExpired = React.useCallback(() => {
    if (!submittedRef.current) {
      submittedRef.current = true;
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reason: submit is stable within this component's lifetime.
  }, []);

  // ANSWERS THE SERVER DOES NOT HOLD.
  //
  // Every save here is optimistic — the tick lands on screen and the POST
  // follows — and a failed POST used to leave the tick standing. The candidate
  // saw their choice selected, believed it recorded, and the script held
  // nothing: silent partial success, on a child's exam answer.
  //
  // It is not hypothetical. The per-tenant limiter is 1,200 requests a minute
  // KEYED ON THE SCHOOL, and an exam hall is precisely where one school makes
  // many at once — measured, a compressed 1,000-candidate sitting is refused
  // 429 mid-paper. A school's own wifi does the same thing for free.
  //
  // So: retry a transient failure, and where it still fails SAY WHICH
  // QUESTIONS ARE UNSAVED rather than only flashing a banner. The choice stays
  // on screen — losing the candidate's intent would be a worse answer than
  // showing it as not yet saved — and submit warns before it closes over one.
  // The map is OPEN on a short paper and CLOSED on a long one: eight numbers
  // are a glance, a hundred are a wall in front of the question being answered.
  const [mapOpen, setMapOpen] = React.useState(() => initial.questions.length <= 12);
  const [unsaved, setUnsaved] = React.useState<Record<string, true>>({});
  const mark = (questionId: string, failed: boolean) =>
    setUnsaved((cur) => {
      if (failed) return cur[questionId] ? cur : { ...cur, [questionId]: true };
      if (!cur[questionId]) return cur;
      const next = { ...cur };
      delete next[questionId];
      return next;
    });
  const unsavedCount = Object.keys(unsaved).length;

  /**
   * POST, and keep trying while the failure is a transient one.
   *
   * The question is FLAGGED FROM THE FIRST FAILURE rather than after the last
   * attempt: the whole point is that the screen must never show an answer the
   * server does not hold, and a retry that takes a minute would leave it
   * looking saved for that minute.
   *
   * `Retry-After` is honoured where the server sends it — the per-school
   * window can be up to a minute away, and guessing 400ms against that burns
   * every attempt for nothing.
   */
  const saveAnswer = React.useCallback(
    async (questionId: string, path: string, body: unknown) => {
      let last: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) {
          const after = Number(last?.headers.get("retry-after") ?? 0);
          const waitMs = after > 0 ? Math.min(after * 1000 + 250, 65_000) : 400 * attempt;
          await new Promise((r) => setTimeout(r, waitMs));
        }
        last = await fetch(`/api/sms/${basePath}/sittings/${s.sittingId}/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).catch(() => null as unknown as Response);
        if (last?.ok) return null;
        mark(questionId, true);
        // A REFUSAL IS NOT A BLIP. 400/403/409 mean the server has decided —
        // the sitting is closed, the question is not on this paper — and
        // retrying it three more times only delays telling the candidate.
        if (last && last.status < 500 && last.status !== 429) break;
      }
      return last ? await readApiError(last) : "The answer could not be sent. Check your connection.";
    },
    [basePath, s.sittingId],
  );

  const pick = async (questionId: string, choiceIndex: number) => {
    if (!open) return;
    // Optimistic: the local mark lands immediately; the server save follows.
    setS((cur) => ({ ...cur, answers: { ...cur.answers, [questionId]: choiceIndex } }));
    const err = await saveAnswer(questionId, "answer", { questionId, choiceIndex });
    mark(questionId, err !== null);
    setMsg(err);
  };

  // THEORY autosave. Debounced per question so typing doesn't post per keystroke,
  // and it writes ONE row server-side (not the whole answer blob).
  const timers = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const write = async (questionId: string, text: string) => {
    if (!open) return;
    setS((cur) => ({ ...cur, theoryAnswers: { ...cur.theoryAnswers, [questionId]: text } }));
    clearTimeout(timers.current[questionId]);
    timers.current[questionId] = setTimeout(async () => {
      // The same retry and the same marker. Reverting is NOT the answer here —
      // the candidate has typed an essay and destroying it would be worse than
      // the bug — so the text stays and the question is flagged unsaved.
      const err = await saveAnswer(questionId, "answer-theory", { questionId, text });
      mark(questionId, err !== null);
      setMsg(err);
    }, 800);
  };

  async function submit() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/sms/${basePath}/sittings/${s.sittingId}/submit`, { method: "POST" });
    setBusy(false);
    if (res.ok) setS((await res.json()) as Sitting);
    else setMsg(await readApiError(res));
  }

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
            <ExamClock deadline={s.deadline} onExpired={onExpired} />
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

      {/* TRANSPARENT MONITORING NOTICE. Always shown while the paper is open, so a
          candidate knows before they act — not a warning that only appears once
          they've already left. Escalates in tone once it has actually happened. */}
      {open && (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-xs",
            integrity.focusLosses > 0
              ? "border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-300"
              : "border-border bg-muted/40 text-muted-foreground",
          )}
        >
          {integrity.focusLosses > 0 ? (
            <>
              <span className="font-semibold">
                You have left this exam {integrity.focusLosses} time
                {integrity.focusLosses === 1 ? "" : "s"} ({Math.round(integrity.awayMs / 1000)}s away).
              </span>{" "}
              This is recorded and shown to your teacher. Stay on this page until you submit.
            </>
          ) : (
            <>
              Keep this tab open until you submit. Leaving the exam — switching tabs, apps or windows — is recorded and
              shown to your teacher. Your time keeps running either way.
            </>
          )}
        </div>
      )}

      {/* QUESTION NAVIGATOR — the answered/pending map, and the only way to move
          around a paper that is ALL ON ONE PAGE.
          Filled = answered, outlined = still to do. Tap a number to jump straight
          there, so nothing is left unanswered just because it was further down the
          page. Purely derived state: no request, and it can't disturb the paper.

          STICKY, because it was not. A forty-question paper is a long page, and
          from question thirty a candidate could neither see the clock nor jump
          anywhere without scrolling all the way back to the top — so "you can
          jump to any question" was true of the markup and false of the exam.
          The grid COLLAPSES by default beyond a short paper and scrolls inside
          its own box, so a hundred numbers can never cover the question being
          answered. */}
      {open && (
        <Card className="sticky top-2 z-20 shadow-sm">
          <CardContent className="space-y-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {answered}/{s.questions.length} answered
                {pending > 0 ? ` · ${pending} left` : " · all done"}
              </p>
              <div className="flex items-center gap-2">
                <ExamClock deadline={s.deadline} onExpired={onExpired} className="px-2 py-0.5 text-xs" />
                {/* The clock travels WITH the navigator, so the two facts a
                    candidate needs mid-paper — how long is left, and what is
                    still unanswered — are in one place they can always see. */}
                <button
                  type="button"
                  onClick={() => setMapOpen((v) => !v)}
                  aria-expanded={mapOpen}
                  className="rounded-md border px-2 py-0.5 text-xs font-medium hover:bg-muted"
                >
                  {mapOpen ? "Hide questions" : "All questions"}
                </button>
              </div>
            </div>
            <div className={cn("flex flex-wrap items-center justify-between gap-2", !mapOpen && "hidden")}>
              <p className="text-xs text-muted-foreground">
                Tap a number to jump to that question.
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
            <div className={cn("flex max-h-40 flex-wrap gap-1.5 overflow-y-auto", !mapOpen && "hidden")}>
              {s.questions.map((q, i) => {
                const done = answeredIds.has(q.id);
                // A THIRD state, and it is the point: an answer the server has
                // not taken is neither "answered" nor "still to do", and
                // colouring it as answered is the lie being fixed.
                const notSaved = unsaved[q.id] === true;
                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => jumpTo(q.id)}
                    aria-label={`Question ${i + 1}: ${notSaved ? "answered but NOT saved" : done ? "answered" : "not answered"}${q.type === "THEORY" ? " (theory)" : ""}`}
                    title={notSaved ? `Question ${i + 1} — your answer has not been saved` : done ? `Question ${i + 1} — answered` : `Question ${i + 1} — not answered yet`}
                    className={cn(
                      "tnum grid h-8 w-8 place-items-center rounded-md border text-xs font-semibold transition-colors",
                      notSaved
                        ? "border-destructive bg-destructive/15 text-destructive"
                        : done
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
            <p className={cn("text-[0.7rem] text-muted-foreground", !mapOpen && "hidden")}>
              Filled = answered · outlined = still to do{s.questions.some((q) => q.type === "THEORY") ? " · round = theory (written answer)" : ""}
              {unsavedCount > 0 ? " · red = not saved, choose it again" : ""}
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
          <Card ref={(el) => { cardRefs.current[q.id] = el; }} className={cn(open && unsaved[q.id] ? "border-destructive/60" : open && !done && "border-amber-500/40")}>
            <CardContent className="space-y-3 p-4">
              <p className="text-sm font-medium">
                <span className="mr-2 text-muted-foreground">{i + 1}.</span>
                {q.prompt}
                {open && unsaved[q.id] && (
                  <span className="ml-2 rounded bg-destructive/15 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase text-destructive">
                    not saved — choose again
                  </span>
                )}
                {open && !done && !unsaved[q.id] && (
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
                    onPaste={(e) => {
                      // Recorded, NOT blocked — blocking breaks assistive tech and
                      // is trivially worked around anyway.
                      const chars = e.clipboardData?.getData("text")?.length ?? 0;
                      if (chars > 0) {
                        queue.current.push({ type: "PASTE", chars });
                        void flush();
                      }
                    }}
                    placeholder="Write your answer…"
                    aria-label={`Answer for question ${i + 1}`}
                  />
                  <p className="text-xs text-muted-foreground">
                    {q.maxMarks} mark{q.maxMarks === 1 ? "" : "s"} · saved as you type · marked by your teacher
                  </p>
                </div>
              ) : (
              <div className={cn("grid gap-2", shortOptions(q.choices) && "sm:grid-cols-2")}>
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
                        "flex items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
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
                      <span className="min-w-0 break-words">{choice}</span>
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

      {/* NAMED, not just counted. "Something went wrong" sends a candidate
          looking; the question numbers tell them exactly what to click again. */}
      {open && unsavedCount > 0 && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {unsavedCount === 1 ? "One answer has" : `${unsavedCount} answers have`} not been saved
          — question{unsavedCount === 1 ? "" : "s"}{" "}
          {s.questions.map((q, i) => (unsaved[q.id] ? i + 1 : null)).filter(Boolean).join(", ")}.
          Choose {unsavedCount === 1 ? "it" : "them"} again. Your paper is scored from what the
          server holds, not from what is shown here.
        </p>
      )}
      {msg && <p className="text-sm text-destructive">{msg}</p>}
      {open && (
        <div className="sticky bottom-4 flex justify-end">
          <Button
            size="lg"
            disabled={busy}
            onClick={() => {
              // AN UNSAVED ANSWER IS ASKED ABOUT FIRST, and separately, because
              // it is a different fact from an unanswered one: the candidate DID
              // answer and the server did not take it, so submitting now loses a
              // mark they earned. Named by number, and it lands them on it.
              const stillUnsaved = s.questions.filter((q) => unsaved[q.id]);
              if (
                stillUnsaved.length > 0 &&
                !window.confirm(
                  `${stillUnsaved.length} answer${stillUnsaved.length === 1 ? "" : "s"} could not be saved (question${stillUnsaved.length === 1 ? "" : "s"} ${stillUnsaved
                    .map((q) => s.questions.indexOf(q) + 1)
                    .join(", ")}). Submitting now scores this paper WITHOUT them. Submit anyway?`,
                )
              ) {
                jumpTo(stillUnsaved[0].id);
                return;
              }
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
