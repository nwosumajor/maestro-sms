"use client";

// Host console for the Live Quiz: AUTHOR a themed quiz, then OPEN a session for
// one of your classes (which redirects into the play screen to drive it). Gated
// by game.quiz.host at the API; this UI is only rendered for hosts.

import type { IdNameDto, LiveQuizSummaryDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusLine, postSms } from "./play-ui";

const THEMES = ["GEOGRAPHY", "SCIENCE", "ART", "LITERATURE", "GENERAL"] as const;
const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;

type Draft = { prompt: string; choices: string[]; answerIndex: number };
const emptyQuestion = (): Draft => ({ prompt: "", choices: ["", "", "", ""], answerIndex: 0 });

export function QuizHostConsole({
  quizzes,
  classes,
}: {
  quizzes: Serialized<LiveQuizSummaryDto>[];
  classes: Serialized<IdNameDto>[];
}) {
  const router = useRouter();
  const [title, setTitle] = React.useState("");
  const [theme, setTheme] = React.useState<(typeof THEMES)[number]>("GEOGRAPHY");
  const [difficulty, setDifficulty] = React.useState<(typeof DIFFICULTIES)[number]>("MEDIUM");
  const [questions, setQuestions] = React.useState<Draft[]>([emptyQuestion()]);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const setQ = (i: number, patch: Partial<Draft>) =>
    setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const setChoice = (i: number, c: number, v: string) =>
    setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, choices: q.choices.map((x, k) => (k === c ? v : x)) } : q)));

  const createQuiz = async () => {
    setMsg(null);
    setErr(false);
    // Drop blank trailing choices; every question needs >= 2 non-empty choices.
    const cleaned = questions.map((q) => ({
      prompt: q.prompt.trim(),
      choices: q.choices.map((c) => c.trim()).filter(Boolean),
      answerIndex: q.answerIndex,
    }));
    if (!title.trim()) return fail("Give the quiz a title.");
    for (const [i, q] of cleaned.entries()) {
      if (!q.prompt) return fail(`Question ${i + 1} needs a prompt.`);
      if (q.choices.length < 2) return fail(`Question ${i + 1} needs at least two choices.`);
      if (q.answerIndex >= q.choices.length) return fail(`Question ${i + 1}: pick which choice is correct.`);
    }
    setBusy(true);
    const r = await postSms("quizzes", { title: title.trim(), theme, difficulty, questions: cleaned });
    setBusy(false);
    if (!r.ok) return fail(r.error ?? `Failed (${r.status}).`);
    setMsg("Quiz saved. Open a session below to host it.");
    setErr(false);
    setTitle("");
    setQuestions([emptyQuestion()]);
    router.refresh();
  };

  const fail = (m: string) => {
    setErr(true);
    setMsg(m);
  };

  const openSession = async (quizId: string, classId: string) => {
    if (!classId) return fail("Pick a class to host for.");
    const r = await postSms<{ id: string }>("quiz-sessions", { quizId, classId });
    if (!r.ok || !r.data) return fail(r.error ?? `Failed (${r.status}).`);
    router.push(`/games/quiz/${r.data.id}`);
  };

  return (
    <div className="space-y-6">
      {/* Author a quiz */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create a quiz</CardTitle>
          <CardDescription>
            Build a themed multiple-choice quiz. Harder difficulty gives players less time and more points.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[14rem] flex-1 space-y-1.5">
              <Label htmlFor="q-title">Title</Label>
              <Input id="q-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="World Capitals" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-theme">Theme</Label>
              <select
                id="q-theme"
                value={theme}
                onChange={(e) => setTheme(e.target.value as (typeof THEMES)[number])}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {THEMES.map((t) => (
                  <option key={t} value={t}>
                    {t.charAt(0) + t.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-diff">Difficulty</Label>
              <select
                id="q-diff"
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as (typeof DIFFICULTIES)[number])}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>
                    {d.charAt(0) + d.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-4">
            {questions.map((q, i) => (
              <div key={i} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted-foreground">Question {i + 1}</span>
                  {questions.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}
                      className="text-xs text-muted-foreground hover:text-destructive"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <Input value={q.prompt} onChange={(e) => setQ(i, { prompt: e.target.value })} placeholder="Prompt…" />
                <div className="grid gap-2 sm:grid-cols-2">
                  {q.choices.map((c, k) => (
                    <label key={k} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`correct-${i}`}
                        checked={q.answerIndex === k}
                        onChange={() => setQ(i, { answerIndex: k })}
                        title="Mark correct"
                      />
                      <Input
                        value={c}
                        onChange={(e) => setChoice(i, k, e.target.value)}
                        placeholder={`Choice ${"ABCDEF"[k]}${k < 2 ? " (required)" : ""}`}
                      />
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Select the radio next to the correct choice.</p>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setQuestions((qs) => [...qs, emptyQuestion()])}>
              + Add question
            </Button>
          </div>

          <StatusLine msg={msg} error={err} />
          <Button onClick={createQuiz} disabled={busy}>
            {busy ? "Saving…" : "Save quiz"}
          </Button>
        </CardContent>
      </Card>

      {/* Host a session */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Host a session</CardTitle>
          <CardDescription>Pick a saved quiz and a class; students in that class can then join.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {quizzes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No quizzes yet — create one above.</p>
          ) : (
            quizzes.map((quiz) => <HostRow key={quiz.id} quiz={quiz} classes={classes} onOpen={openSession} />)
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function HostRow({
  quiz,
  classes,
  onOpen,
}: {
  quiz: Serialized<LiveQuizSummaryDto>;
  classes: Serialized<IdNameDto>[];
  onOpen: (quizId: string, classId: string) => void;
}) {
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{quiz.title}</p>
        <p className="text-xs text-muted-foreground">
          {quiz.theme.charAt(0) + quiz.theme.slice(1).toLowerCase()} · {quiz.difficulty.toLowerCase()} ·{" "}
          {quiz.questionCount} question{quiz.questionCount === 1 ? "" : "s"}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <select
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
        >
          {classes.length === 0 && <option value="">No classes</option>}
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button size="sm" disabled={!classId} onClick={() => onOpen(quiz.id, classId)}>
          Host
        </Button>
      </div>
    </div>
  );
}
