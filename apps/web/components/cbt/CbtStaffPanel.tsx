"use client";

// Staff CBT console. Question banks are authored per-question (Kahoot-style
// form: prompt + option fields + a radio marking the correct choice), with a
// bulk-paste mode for spreadsheet imports. A teacher is scoped to the subjects
// and classes they teach (the server enforces it; the pickers only offer them).
// Publishing an exam and releasing its answer key are both maker-checker: the
// author requests, a different reviewer (publish) / the principal (answers)
// approves via the Approvals inbox. The server holds every answer key; this
// panel never sees one for an open sitting.

import type { CbtAuthoringOptionsDto, CbtBankDto, CbtExamDto, CbtExamResultsDto, Serialized } from "@sms/types";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";
import { dateTime } from "@/lib/format";

type Bank = Serialized<CbtBankDto>;
type Exam = Serialized<CbtExamDto>;
type Options = Serialized<CbtAuthoringOptionsDto>;

async function post(path: string, body?: unknown, method = "POST") {
  return fetch(`/api/sms/${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

type DraftQuestion = { prompt: string; choices: string[]; answerIndex: number };
const emptyQuestion = (): DraftQuestion => ({ prompt: "", choices: ["", "", "", ""], answerIndex: 0 });

/** One question per line: prompt | choice1 | choice2 | ... | #correctIndex */
function parseBulk(text: string): DraftQuestion[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((p) => p.trim());
      const last = parts[parts.length - 1] ?? "";
      const answerIndex = Number(last.replace(/^#/, ""));
      return { prompt: parts[0] ?? "", choices: parts.slice(1, -1), answerIndex };
    });
}

/** Drop blank options and re-point answerIndex at the kept correct one.
 *  Returns an error string instead when the question doesn't hold together. */
function compactQuestion(q: DraftQuestion, n: number): DraftQuestion | string {
  const prompt = q.prompt.trim();
  if (!prompt) return `Question ${n} needs a prompt.`;
  const kept: string[] = [];
  let answerIndex = -1;
  q.choices.forEach((c, i) => {
    const v = c.trim();
    if (!v) return;
    if (i === q.answerIndex) answerIndex = kept.length;
    kept.push(v);
  });
  if (kept.length < 2) return `Question ${n} needs at least two options.`;
  if (answerIndex < 0) return `Question ${n}: mark one of the filled options as correct.`;
  return { prompt, choices: kept, answerIndex };
}

export function CbtStaffPanel({ banks, exams, options }: { banks: Bank[]; exams: Exam[]; options: Options }) {
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Bank create
  const [bankName, setBankName] = React.useState("");
  const [bankSubjectId, setBankSubjectId] = React.useState(options.subjects[0]?.id ?? "");

  // Question authoring
  const [qBank, setQBank] = React.useState(banks[0]?.id ?? "");
  const [qMode, setQMode] = React.useState<"form" | "bulk">("form");
  const [questions, setQuestions] = React.useState<DraftQuestion[]>([emptyQuestion()]);
  const [qText, setQText] = React.useState("");

  // Exam create
  const [exam, setExam] = React.useState({
    title: "",
    bankId: banks[0]?.id ?? "",
    classId: "",
    questionCount: "20",
    durationMinutes: "40",
    startAt: "",
    endAt: "",
  });
  const [results, setResults] = React.useState<Serialized<CbtExamResultsDto> | null>(null);

  const setQ = (i: number, patch: Partial<DraftQuestion>) =>
    setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const setChoice = (i: number, k: number, v: string) =>
    setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, choices: q.choices.map((x, m) => (m === k ? v : x)) } : q)));

  const act = async (fn: () => Promise<Response>, okMsg: string, reload = true) => {
    setBusy(true);
    setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) {
      setMsg(okMsg);
      if (reload) window.location.reload();
      return res;
    }
    setMsg(await readApiError(res));
    return null;
  };

  const saveQuestions = () => {
    let payload: DraftQuestion[];
    if (qMode === "form") {
      payload = [];
      for (let i = 0; i < questions.length; i++) {
        const out = compactQuestion(questions[i]!, i + 1);
        if (typeof out === "string") return setMsg(out);
        payload.push(out);
      }
    } else {
      payload = parseBulk(qText);
      const bad = payload.find(
        (q) => !q.prompt || q.choices.length < 2 || !Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex >= q.choices.length,
      );
      if (bad) return setMsg(`Check this line — it doesn't parse: "${bad.prompt || "(empty)"}"`);
      if (payload.length === 0) return setMsg("Nothing to add yet.");
    }
    void act(() => post(`cbt/banks/${qBank}/questions`, { questions: payload }), `${payload.length} question${payload.length === 1 ? "" : "s"} added.`);
  };

  // A teacher may only aim an exam at a class where they teach the bank's subject.
  const examBank = banks.find((b) => b.id === exam.bankId);
  const examClasses = options.schoolWide
    ? options.classes
    : options.classes.filter((c) => !examBank?.subjectId || (c.subjectIds ?? []).includes(examBank.subjectId));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Question banks</CardTitle>
          <CardDescription>
            {options.schoolWide
              ? "Reusable pools of multiple-choice questions, organised by subject."
              : "Reusable pools of multiple-choice questions for the subjects you teach."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {banks.length > 0 && (
            <ul className="space-y-1.5">
              {banks.map((b) => (
                <li key={b.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">{b.name}</span>
                    {b.subject && <span className="text-muted-foreground"> · {b.subject}</span>}
                  </span>
                  <Badge variant="secondary">{b.questionCount} questions</Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <Input className="w-56" placeholder="New bank name" value={bankName} onChange={(e) => setBankName(e.target.value)} />
            <select
              value={bankSubjectId}
              onChange={(e) => setBankSubjectId(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {options.schoolWide && <option value="">(no subject)</option>}
              {options.subjects.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={busy || !bankName.trim() || (!options.schoolWide && !bankSubjectId)}
              onClick={() => act(() => post("cbt/banks", { name: bankName, subjectId: bankSubjectId || null }), "Bank created.")}
            >
              Create bank
            </Button>
          </div>
          {!options.schoolWide && options.subjects.length === 0 && (
            <p className="text-sm text-muted-foreground">
              You aren&apos;t assigned to any class subject yet — ask your school admin to assign you before creating a bank.
            </p>
          )}

          {banks.length > 0 && (
            <div className="space-y-3 border-t border-border pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Add questions to</span>
                <select value={qBank} onChange={(e) => setQBank(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                  {banks.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                <span className="ml-auto flex rounded-md border border-border p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setQMode("form")}
                    className={`rounded px-2 py-1 ${qMode === "form" ? "bg-muted font-medium" : "text-muted-foreground"}`}
                  >
                    Question form
                  </button>
                  <button
                    type="button"
                    onClick={() => setQMode("bulk")}
                    className={`rounded px-2 py-1 ${qMode === "bulk" ? "bg-muted font-medium" : "text-muted-foreground"}`}
                  >
                    Bulk paste
                  </button>
                </span>
              </div>

              {qMode === "form" ? (
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
                      <Input value={q.prompt} onChange={(e) => setQ(i, { prompt: e.target.value })} placeholder="Type the question…" />
                      <div className="grid gap-2 sm:grid-cols-2">
                        {q.choices.map((c, k) => (
                          <label key={k} className="flex items-center gap-2">
                            <input
                              type="radio"
                              name={`cbt-correct-${i}`}
                              checked={q.answerIndex === k}
                              onChange={() => setQ(i, { answerIndex: k })}
                              title="Mark correct"
                            />
                            <Input
                              value={c}
                              onChange={(e) => setChoice(i, k, e.target.value)}
                              placeholder={`Option ${"ABCDEF"[k]}${k < 2 ? " (required)" : ""}`}
                            />
                          </label>
                        ))}
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">Select the radio next to the correct option — that&apos;s the marking key.</p>
                        {q.choices.length < 6 && (
                          <button
                            type="button"
                            onClick={() => setQ(i, { choices: [...q.choices, ""] })}
                            className="text-xs text-muted-foreground hover:text-foreground"
                          >
                            + option
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setQuestions((qs) => [...qs, emptyQuestion()])}>
                      + Add another question
                    </Button>
                    <Button size="sm" disabled={busy || !qBank} onClick={saveQuestions}>
                      Save {questions.length} question{questions.length === 1 ? "" : "s"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    One question per line:{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs">Prompt | choice A | choice B | choice C | #0</code>{" "}
                    (the #number is the correct choice, counted from 0).
                  </p>
                  <Textarea
                    rows={5}
                    value={qText}
                    onChange={(e) => setQText(e.target.value)}
                    placeholder={"What is 2 + 2? | 3 | 4 | 5 | #1\nCapital of Nigeria? | Lagos | Abuja | Kano | #1"}
                    className="font-mono text-xs"
                  />
                  <Button size="sm" disabled={busy || !qText.trim() || !qBank} onClick={saveQuestions}>
                    Add questions
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Exams</CardTitle>
          <CardDescription>
            Each sitting samples the chosen number of questions from the bank in a fresh order; the timer and the
            marking are enforced by the server. Publishing needs a second approver, and correct answers reach
            students only after you request release and the principal approves.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {exams.length > 0 && (
            <ul className="space-y-1.5">
              {exams.map((e) => {
                const windowEnded = new Date(e.endAt).getTime() < Date.now();
                const releasable = (e.status === "CLOSED" || windowEnded) && e.answerRelease === "HIDDEN";
                return (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                    <span>
                      <span className="font-medium">{e.title}</span>{" "}
                      <span className="text-muted-foreground">
                        · {e.questionCount} questions · {e.durationMinutes} min · {dateTime(e.startAt)} → {dateTime(e.endAt)} · {e.sittings} sat
                      </span>{" "}
                      <Badge variant={e.status === "PUBLISHED" ? "default" : e.status === "CLOSED" ? "outline" : "secondary"}>
                        {e.status === "PENDING_APPROVAL" ? "AWAITING APPROVAL" : e.status}
                      </Badge>{" "}
                      {e.answerRelease === "REQUESTED" && <Badge variant="secondary">Answers: awaiting principal</Badge>}
                      {e.answerRelease === "RELEASED" && <Badge variant="default">Answers released</Badge>}
                    </span>
                    <span className="flex gap-2">
                      {e.status === "DRAFT" && (
                        <Button size="sm" disabled={busy} onClick={() => act(() => post(`cbt/exams/${e.id}/request-publish`), "Submitted for approval.")}>
                          Submit for approval
                        </Button>
                      )}
                      {e.status === "PUBLISHED" && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => post(`cbt/exams/${e.id}/status`, { status: "CLOSED" }, "PUT"), "Closed.")}>
                          Close
                        </Button>
                      )}
                      {releasable && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => act(() => post(`cbt/exams/${e.id}/request-answer-release`), "Answer release requested — awaiting the principal.")}
                        >
                          Request answer release
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={async () => {
                          const res = await act(() => fetch(`/api/sms/cbt/exams/${e.id}/results`), "", false);
                          if (res) setResults((await res.json()) as Serialized<CbtExamResultsDto>);
                        }}
                      >
                        Results
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="grid gap-2 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-3">
            <Input placeholder="Exam title" value={exam.title} onChange={(e) => setExam({ ...exam, title: e.target.value })} />
            <select value={exam.bankId} onChange={(e) => setExam({ ...exam, bankId: e.target.value, classId: "" })} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              {banks.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <select value={exam.classId} onChange={(e) => setExam({ ...exam, classId: e.target.value })} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              {options.schoolWide ? <option value="">Whole school</option> : <option value="">Pick your class…</option>}
              {examClasses.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <Input className="tnum" inputMode="numeric" placeholder="Questions per sitting" value={exam.questionCount} onChange={(e) => setExam({ ...exam, questionCount: e.target.value.replace(/\D/g, "") })} />
            <Input className="tnum" inputMode="numeric" placeholder="Duration (minutes)" value={exam.durationMinutes} onChange={(e) => setExam({ ...exam, durationMinutes: e.target.value.replace(/\D/g, "") })} />
            <div className="grid grid-cols-2 gap-2">
              <Input type="datetime-local" value={exam.startAt} onChange={(e) => setExam({ ...exam, startAt: e.target.value })} />
              <Input type="datetime-local" value={exam.endAt} onChange={(e) => setExam({ ...exam, endAt: e.target.value })} />
            </div>
          </div>
          <Button
            size="sm"
            disabled={busy || !exam.title.trim() || !exam.bankId || !exam.startAt || !exam.endAt || (!options.schoolWide && !exam.classId)}
            onClick={() =>
              act(
                () =>
                  post("cbt/exams", {
                    bankId: exam.bankId,
                    title: exam.title,
                    classId: exam.classId || null,
                    questionCount: Number(exam.questionCount) || 20,
                    durationMinutes: Number(exam.durationMinutes) || 40,
                    startAt: new Date(exam.startAt).toISOString(),
                    endAt: new Date(exam.endAt).toISOString(),
                  }),
                "Exam created (draft — submit it for approval when ready).",
              )
            }
          >
            Create exam
          </Button>
          {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        </CardContent>
      </Card>

      {results && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Results — {results.exam.title}</CardTitle>
            <CardDescription>
              Auto-marked scores for staff review. Any consequence (a grade entry, a follow-up) is a separate,
              deliberate staff action.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {results.rows.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">No sittings yet.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {results.rows.map((r) => (
                    <tr key={r.sittingId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">{r.studentName}</td>
                      <td className="px-4 py-2">
                        <Badge variant={r.status === "SUBMITTED" ? "secondary" : r.status === "EXPIRED" ? "destructive" : "default"}>
                          {r.status}
                        </Badge>
                      </td>
                      <td className="tnum px-4 py-2 text-right font-medium">
                        {r.score != null ? `${r.score} / ${r.total}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
