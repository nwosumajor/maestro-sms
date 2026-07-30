"use client";

// =============================================================================
// Theory marking console — VERTICAL marking
// =============================================================================
// One question at a time, across the whole class. That ordering is the point:
// the mark scheme is read once and every answer to that question is judged
// against it back-to-back, so marks stay comparable and the pass is far quicker
// than working script-by-script.
//
// Candidates are ANONYMOUS until the question is fully marked — the server sends
// pseudonyms and withholds the names, so there is nothing here to un-hide.

import * as React from "react";
import type { CbtMarkingProgressDto, CbtMarkingQueueDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type Progress = Serialized<CbtMarkingProgressDto>;
type Queue = Serialized<CbtMarkingQueueDto>;

export function CbtMarkingConsole({ examId, examTitle }: { examId: string; examTitle: string }) {
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const [queue, setQueue] = React.useState<Queue | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const loadProgress = React.useCallback(async () => {
    const res = await fetch(`/api/sms/cbt/exams/${examId}/marking/progress`);
    if (!res.ok) {
      setErr(await readApiError(res));
      return;
    }
    setProgress((await res.json()) as Progress);
  }, [examId]);

  React.useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  const openQuestion = async (questionId: string) => {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/sms/cbt/exams/${examId}/marking?questionId=${encodeURIComponent(questionId)}`);
    setBusy(false);
    if (!res.ok) {
      setErr(await readApiError(res));
      return;
    }
    setQueue((await res.json()) as Queue);
  };

  const mark = async (answerId: string, marks: number, comment: string) => {
    const res = await fetch(`/api/sms/cbt/marking/${answerId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marks, comment: comment || null }),
    });
    if (!res.ok) {
      setErr(await readApiError(res));
      return false;
    }
    // Reflect locally, then refresh progress so the header counts stay honest.
    setQueue((q) =>
      q
        ? {
            ...q,
            marked: q.answers.filter((a) => (a.answerId === answerId ? true : a.marksAwarded !== null)).length,
            answers: q.answers.map((a) =>
              a.answerId === answerId ? { ...a, marksAwarded: marks, comment: comment || null } : a,
            ),
          }
        : q,
    );
    void loadProgress();
    return true;
  };

  if (!progress) {
    return <p className="text-sm text-muted-foreground">{err ?? "Loading marking…"}</p>;
  }
  if (progress.questions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nothing to mark</CardTitle>
          <CardDescription>
            {examTitle} has no theory answers — either it is objective-only, or no candidate has submitted written work yet.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Marking — {examTitle}
            {progress.provisional ? (
              <Badge variant="destructive">Results provisional</Badge>
            ) : (
              <Badge>Marking complete</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Pick a question and mark it across the whole class. While any answer is unmarked, a candidate&apos;s score is only
            the objective part and is not final.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {progress.questions.map((q) => (
              <li key={q.questionId} className="flex flex-wrap items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{q.prompt}</p>
                  <p className="text-xs text-muted-foreground">
                    {q.maxMarks} mark{q.maxMarks === 1 ? "" : "s"} ·{" "}
                    <span className={q.marked < q.total ? "text-amber-600 dark:text-amber-400" : ""}>
                      {q.marked}/{q.total} marked
                    </span>
                  </p>
                </div>
                <Button size="sm" variant={queue?.questionId === q.questionId ? "default" : "outline"} disabled={busy} onClick={() => void openQuestion(q.questionId)}>
                  {q.marked < q.total ? "Mark" : "Review"}
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {err && <p className="text-sm text-destructive">{err}</p>}

      {queue && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {queue.prompt}
              <Badge variant="outline">
                {queue.marked}/{queue.total} marked
              </Badge>
              {queue.anonymous && <Badge variant="secondary">Anonymous</Badge>}
            </CardTitle>
            {queue.markGuide && (
              <CardDescription>
                <span className="font-medium">Mark scheme:</span> {queue.markGuide}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {queue.answers.map((a) => (
                <AnswerRow key={a.answerId} a={a} maxMarks={queue.maxMarks} onMark={mark} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AnswerRow({
  a,
  maxMarks,
  onMark,
}: {
  a: Queue["answers"][number];
  maxMarks: number;
  onMark: (answerId: string, marks: number, comment: string) => Promise<boolean>;
}) {
  const [marks, setMarks] = React.useState(a.marksAwarded === null ? "" : String(a.marksAwarded));
  const [comment, setComment] = React.useState(a.comment ?? "");
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(a.marksAwarded !== null);

  const submit = async () => {
    const n = Number(marks);
    if (!Number.isInteger(n) || n < 0 || n > maxMarks) return;
    setSaving(true);
    const ok = await onMark(a.answerId, n, comment);
    setSaving(false);
    if (ok) setSaved(true);
  };

  return (
    <li className="rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          {a.studentName ?? a.candidateLabel}
        </p>
        {saved && <Badge>{marks}/{maxMarks}</Badge>}
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm">{a.text}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Marks
          <Input
            className="h-8 w-16 text-sm"
            value={marks}
            inputMode="numeric"
            onChange={(e) => {
              setMarks(e.target.value);
              setSaved(false);
            }}
            // Enter marks and move on — the fast path for a long marking pass.
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            aria-label={`Marks for ${a.candidateLabel}`}
          />
          <span>/ {maxMarks}</span>
        </label>
        <Input
          className="h-8 flex-1 text-sm"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Comment (optional)"
          aria-label={`Comment for ${a.candidateLabel}`}
        />
        <Button size="sm" disabled={saving || marks === ""} onClick={() => void submit()}>
          {saving ? "Saving…" : saved ? "Update" : "Save"}
        </Button>
      </div>
    </li>
  );
}
