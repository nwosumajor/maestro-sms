"use client";

// Staff CBT console: question banks (create + bulk-add questions), exams
// (create over a bank, publish/close), and a per-exam results drawer. Server
// holds every answer key; this panel never sees one for an open sitting.

import type { CbtBankDto, CbtExamDto, CbtExamResultsDto, Serialized } from "@sms/types";
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

async function post(path: string, body?: unknown, method = "POST") {
  return fetch(`/api/sms/${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** One question per line: prompt | choice1 | choice2 | ... | #correctIndex */
function parseQuestions(text: string): { prompt: string; choices: string[]; answerIndex: number }[] {
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

export function CbtStaffPanel({ banks, exams }: { banks: Bank[]; exams: Exam[] }) {
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [bankName, setBankName] = React.useState("");
  const [bankSubject, setBankSubject] = React.useState("");
  const [qBank, setQBank] = React.useState(banks[0]?.id ?? "");
  const [qText, setQText] = React.useState("");
  const [exam, setExam] = React.useState({ title: "", bankId: banks[0]?.id ?? "", questionCount: "20", durationMinutes: "40", startAt: "", endAt: "" });
  const [results, setResults] = React.useState<Serialized<CbtExamResultsDto> | null>(null);

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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Question banks</CardTitle>
          <CardDescription>
            Reusable pools of multiple-choice questions. Bulk-add with one question per line:{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">Prompt | choice A | choice B | choice C | #0</code>{" "}
            (the #number is the correct choice, counted from 0).
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
            <Input className="w-40" placeholder="Subject (optional)" value={bankSubject} onChange={(e) => setBankSubject(e.target.value)} />
            <Button
              size="sm"
              disabled={busy || !bankName.trim()}
              onClick={() => act(() => post("cbt/banks", { name: bankName, subject: bankSubject || null }), "Bank created.")}
            >
              Create bank
            </Button>
          </div>
          {banks.length > 0 && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Add questions to</span>
                <select value={qBank} onChange={(e) => setQBank(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                  {banks.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
              <Textarea rows={5} value={qText} onChange={(e) => setQText(e.target.value)} placeholder={"What is 2 + 2? | 3 | 4 | 5 | #1\nCapital of Nigeria? | Lagos | Abuja | Kano | #1"} className="font-mono text-xs" />
              <Button
                size="sm"
                disabled={busy || !qText.trim() || !qBank}
                onClick={() => {
                  const questions = parseQuestions(qText);
                  const bad = questions.find((q) => !q.prompt || q.choices.length < 2 || !Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex >= q.choices.length);
                  if (bad) return setMsg(`Check this line — it doesn't parse: "${bad.prompt || "(empty)"}"`);
                  void act(() => post(`cbt/banks/${qBank}/questions`, { questions }), `${questions.length} questions added.`);
                }}
              >
                Add questions
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Exams</CardTitle>
          <CardDescription>
            Each sitting samples the chosen number of questions from the bank in a fresh order. The timer and
            the marking are enforced by the server — closing the tab never gains extra time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {exams.length > 0 && (
            <ul className="space-y-1.5">
              {exams.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">{e.title}</span>{" "}
                    <span className="text-muted-foreground">
                      · {e.questionCount} questions · {e.durationMinutes} min · {dateTime(e.startAt)} → {dateTime(e.endAt)} · {e.sittings} sat
                    </span>{" "}
                    <Badge variant={e.status === "PUBLISHED" ? "default" : e.status === "CLOSED" ? "outline" : "secondary"}>{e.status}</Badge>
                  </span>
                  <span className="flex gap-2">
                    {e.status === "DRAFT" && (
                      <Button size="sm" disabled={busy} onClick={() => act(() => post(`cbt/exams/${e.id}/status`, { status: "PUBLISHED" }, "PUT"), "Published.")}>
                        Publish
                      </Button>
                    )}
                    {e.status === "PUBLISHED" && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => post(`cbt/exams/${e.id}/status`, { status: "CLOSED" }, "PUT"), "Closed.")}>
                        Close
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
              ))}
            </ul>
          )}
          <div className="grid gap-2 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-3">
            <Input placeholder="Exam title" value={exam.title} onChange={(e) => setExam({ ...exam, title: e.target.value })} />
            <select value={exam.bankId} onChange={(e) => setExam({ ...exam, bankId: e.target.value })} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              {banks.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <Input className="tnum" inputMode="numeric" placeholder="Questions per sitting" value={exam.questionCount} onChange={(e) => setExam({ ...exam, questionCount: e.target.value.replace(/\D/g, "") })} />
            <Input className="tnum" inputMode="numeric" placeholder="Duration (minutes)" value={exam.durationMinutes} onChange={(e) => setExam({ ...exam, durationMinutes: e.target.value.replace(/\D/g, "") })} />
            <Input type="datetime-local" value={exam.startAt} onChange={(e) => setExam({ ...exam, startAt: e.target.value })} />
            <Input type="datetime-local" value={exam.endAt} onChange={(e) => setExam({ ...exam, endAt: e.target.value })} />
          </div>
          <Button
            size="sm"
            disabled={busy || !exam.title.trim() || !exam.bankId || !exam.startAt || !exam.endAt}
            onClick={() =>
              act(
                () =>
                  post("cbt/exams", {
                    bankId: exam.bankId,
                    title: exam.title,
                    questionCount: Number(exam.questionCount) || 20,
                    durationMinutes: Number(exam.durationMinutes) || 40,
                    startAt: new Date(exam.startAt).toISOString(),
                    endAt: new Date(exam.endAt).toISOString(),
                  }),
                "Exam created (draft — publish when ready).",
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
