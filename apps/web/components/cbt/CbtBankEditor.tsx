"use client";

import * as React from "react";
import type { CbtBankQuestionsDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readApiError } from "@/lib/api-error";

type Thread = Serialized<CbtBankQuestionsDto>;
type Question = Thread["questions"][number];

/**
 * The author's view of a bank: read the questions back, correct one, remove one.
 *
 * A question a candidate has already SAT is shown as such and its wording,
 * options and answer are read-only — the server refuses those edits, and an
 * input that silently fails is worse than one that is plainly disabled. Its
 * level, topic and mark guide are still editable, because neither changes what
 * anybody saw or how they were marked.
 *
 * The whole bank is read-only while an exam drawing on it is open, for the same
 * reason the server refuses: papers are built as each candidate starts.
 */
export function CbtBankEditor({ bankId, bankName, onChanged }: { bankId: string; bankName: string; onChanged?: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [thread, setThread] = React.useState<Thread | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/sms/cbt/banks/${bankId}/questions`, { cache: "no-store" });
    setBusy(false);
    if (!res.ok) {
      setErr(await readApiError(res));
      return;
    }
    setThread((await res.json()) as Thread);
  }, [bankId]);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!thread) await load();
  };

  const send = async (path: string, method: "PUT" | "DELETE", body?: unknown, ok?: string) => {
    setBusy(true);
    setErr(null);
    setNote(null);
    const res = await fetch(`/api/sms/${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusy(false);
    if (!res.ok) {
      // Carries the server's own sentence — "31 candidates have already sat
      // this question…" explains the refusal better than anything generic.
      setErr(await readApiError(res));
      return false;
    }
    setNote(ok ?? "Saved.");
    setEditing(null);
    await load();
    onChanged?.();
    return true;
  };

  return (
    <div className="mt-2">
      <Button size="sm" variant="outline" onClick={() => void toggle()}>
        {open ? "Hide questions" : "Edit questions"}
      </Button>
      {open && (
        <div className="mt-3 space-y-3 border-t pt-3">
          {busy && <p className="text-sm text-muted-foreground">Working…</p>}
          {err && <p className="text-sm text-destructive">{err}</p>}
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
          {thread?.examOpen && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
              An exam drawing on <strong>{bankName}</strong> is open right now. Papers are built as each candidate starts, so
              this bank cannot be changed until the window closes.
            </p>
          )}
          {thread && thread.questions.length === 0 && <p className="text-sm text-muted-foreground">No questions yet.</p>}
          {thread?.questions.map((q, i) =>
            editing === q.id ? (
              <QuestionForm
                key={q.id}
                q={q}
                index={i}
                frozen={!!q.sat || !!thread.examOpen}
                onCancel={() => setEditing(null)}
                onSave={(body) => send(`cbt/questions/${q.id}`, "PUT", body, "Question updated.")}
              />
            ) : (
              <div key={q.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium">
                    {i + 1}. {q.prompt}
                  </p>
                  <div className="flex shrink-0 items-center gap-2">
                    {q.sat && <Badge variant="secondary">Already sat</Badge>}
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(q.id)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy || !!q.sat || !!thread.examOpen}
                      title={q.sat ? "This question is part of a paper that has been sat" : undefined}
                      onClick={() => {
                        if (window.confirm(`Delete question ${i + 1}? This cannot be undone.`)) {
                          void send(`cbt/questions/${q.id}`, "DELETE", undefined, "Question deleted.");
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                <ul className="mt-1 space-y-0.5 pl-4 text-muted-foreground">
                  {q.choices.map((c, ci) => (
                    <li key={ci} className={ci === q.answerIndex ? "font-medium text-foreground" : undefined}>
                      {String.fromCharCode(65 + ci)}. {c}
                      {ci === q.answerIndex && " ✓"}
                    </li>
                  ))}
                </ul>
                {(q.topic || q.level != null) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {q.topic ?? "No topic"}
                    {q.level != null && ` · level ${q.level}`}
                  </p>
                )}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function QuestionForm({
  q,
  index,
  frozen,
  onCancel,
  onSave,
}: {
  q: Question;
  index: number;
  frozen: boolean;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [prompt, setPrompt] = React.useState(q.prompt);
  const [choices, setChoices] = React.useState<string[]>([...q.choices]);
  const [answerIndex, setAnswerIndex] = React.useState(q.answerIndex ?? 0);
  const [topic, setTopic] = React.useState(q.topic ?? "");
  const [markGuide, setMarkGuide] = React.useState(q.markGuide ?? "");

  const save = () => {
    // Only what the school is allowed to change is sent. Sending a field the
    // server will refuse turns a valid metadata edit into a 409.
    const body: Record<string, unknown> = { topic: topic.trim() || null };
    if (q.type === "THEORY") body.markGuide = markGuide.trim() || null;
    if (!frozen) {
      body.prompt = prompt;
      if (q.type !== "THEORY") {
        body.choices = choices.map((c) => c.trim()).filter(Boolean);
        body.answerIndex = answerIndex;
      }
    }
    void onSave(body);
  };

  return (
    <div className="space-y-2 rounded-md border border-primary/40 p-3 text-sm">
      <p className="text-xs text-muted-foreground">Editing question {index + 1}</p>
      {frozen && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          A candidate has already sat this question, so its wording, options and answer are fixed — the score on file was worked
          out from them. You can still change its topic{q.type === "THEORY" ? " and mark guide" : ""}.
        </p>
      )}
      <Input value={prompt} disabled={frozen} onChange={(e) => setPrompt(e.target.value)} aria-label="Question" />
      {q.type !== "THEORY" &&
        choices.map((c, ci) => (
          <div key={ci} className="flex items-center gap-2">
            <input
              type="radio"
              name={`answer-${q.id}`}
              checked={answerIndex === ci}
              disabled={frozen}
              onChange={() => setAnswerIndex(ci)}
              aria-label={`Mark option ${String.fromCharCode(65 + ci)} correct`}
            />
            <Input
              value={c}
              disabled={frozen}
              onChange={(e) => setChoices(choices.map((x, xi) => (xi === ci ? e.target.value : x)))}
              aria-label={`Option ${String.fromCharCode(65 + ci)}`}
            />
          </div>
        ))}
      <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic (optional)" aria-label="Topic" />
      {q.type === "THEORY" && (
        <Input
          value={markGuide}
          onChange={(e) => setMarkGuide(e.target.value)}
          placeholder="Mark scheme (markers only)"
          aria-label="Mark scheme"
        />
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={save}>
          Save
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
