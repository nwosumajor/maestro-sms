"use client";

// =============================================================================
// ContentManager — author + browse + approve LMS learning content (client)
// =============================================================================
// Display/UX only: the API is authoritative for every permission, relationship
// (teacher-of-class / enrolled), approval transition and quiz answer-key
// redaction. Authors create DRAFTs and submit for principal approval; the
// principal approves/rejects/requests-revision here; everyone opens an item to
// the detail screen to read/take/post. Posts go through the same-origin BFF.
// =============================================================================

import type {
  LmsContentDto,
  LmsContentType,
  QuizQuestionDto,
  Serialized,
} from "@sms/types";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Content = Serialized<LmsContentDto>;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  PUBLISHED: "default",
  PENDING_APPROVAL: "secondary",
  DRAFT: "outline",
  REVISION_REQUESTED: "destructive",
  REJECTED: "destructive",
};

const TYPE_LABEL: Record<LmsContentType, string> = {
  MATERIAL: "Material (PDF)",
  LESSON: "Lesson",
  QUIZ: "Quiz",
  FORUM_THREAD: "Forum thread",
};

async function post(path: string, body?: unknown): Promise<{ ok: boolean; error: string | null }> {
  const res = await fetch(`/api/sms${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok) return { ok: true, error: null };
  const text = await res.text();
  let error = `Failed (${res.status}).`;
  try {
    const j = JSON.parse(text) as { message?: string | string[] };
    if (j.message) error = Array.isArray(j.message) ? j.message.join(", ") : j.message;
  } catch {
    /* keep generic */
  }
  return { ok: false, error };
}

export function ContentManager({
  classId,
  initial,
  canAuthor,
  canReview,
}: {
  classId: string;
  initial: Content[];
  canAuthor: boolean;
  canReview: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);

  const act = async (label: string, fn: () => Promise<{ ok: boolean; error: string | null }>) => {
    const r = await fn();
    setMsg(r.ok ? label : r.error);
    if (r.ok) router.refresh();
  };

  return (
    <div className="space-y-6">
      {canAuthor && (
        <CreateForm
          classId={classId}
          onDone={() => {
            setMsg("Draft created.");
            router.refresh();
          }}
          onError={setMsg}
        />
      )}

      {initial.length === 0 ? (
        <p className="text-sm text-muted-foreground">No content yet.</p>
      ) : (
        <div className="space-y-3">
          {initial.map((c) => (
            <Card key={c.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                <div>
                  <CardTitle className="text-base">
                    <Link href={`/content/${c.id}`} className="hover:underline">
                      {c.title}
                    </Link>
                  </CardTitle>
                  <CardDescription>
                    {TYPE_LABEL[c.type]} · by {c.authorName}
                  </CardDescription>
                </div>
                <Badge variant={STATUS_VARIANT[c.status] ?? "outline"}>
                  {c.status.replace(/_/g, " ").toLowerCase()}
                </Badge>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2">
                <Link href={`/content/${c.id}`} className={buttonVariants({ size: "sm", variant: "outline" })}>
                  Open
                </Link>

                {canAuthor && (c.status === "DRAFT" || c.status === "REVISION_REQUESTED") && (
                  <Button
                    size="sm"
                    onClick={() => act("Submitted for approval.", () => post(`/content/${c.id}/submit`))}
                  >
                    Submit for approval
                  </Button>
                )}

                {canReview && c.status === "PENDING_APPROVAL" && (
                  <>
                    <Button
                      size="sm"
                      onClick={() =>
                        act("Published.", () =>
                          post(`/content/${c.id}/review`, { action: "APPROVE" }),
                        )
                      }
                    >
                      Approve &amp; publish
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        act("Revision requested.", () =>
                          post(`/content/${c.id}/review`, { action: "REQUEST_REVISION" }),
                        )
                      }
                    >
                      Request revision
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() =>
                        act("Rejected.", () => post(`/content/${c.id}/review`, { action: "REJECT" }))
                      }
                    >
                      Reject
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}

// --- create form ------------------------------------------------------------
function CreateForm({
  classId,
  onDone,
  onError,
}: {
  classId: string;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [type, setType] = React.useState<LmsContentType>("LESSON");
  const [title, setTitle] = React.useState("");
  const [html, setHtml] = React.useState("");
  const [intro, setIntro] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [questions, setQuestions] = React.useState<QuizQuestionDto[]>([]);
  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

  const reset = () => {
    setTitle("");
    setHtml("");
    setIntro("");
    setDescription("");
    setQuestions([]);
  };

  const body = (): Record<string, unknown> | null => {
    switch (type) {
      case "MATERIAL":
        return { kind: "MATERIAL", description: description || undefined };
      case "LESSON":
        return { kind: "LESSON", html };
      case "FORUM_THREAD":
        return { kind: "FORUM_THREAD", intro };
      case "QUIZ":
        if (questions.length === 0) return null;
        return { kind: "QUIZ", quiz: { questions } };
      default:
        return null;
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const b = body();
    if (!title.trim()) return onError("Title is required.");
    if (!b) return onError("Add at least one quiz question.");
    const res = await post(`/classes/${classId}/content`, { type, title: title.trim(), body: b });
    if (res.ok) {
      reset();
      onDone();
    } else {
      onError(res.error ?? "Failed.");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create content</CardTitle>
        <CardDescription>
          Saved as a draft. Submit it for the principal to approve before students
          can see it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="ct-type">Type</Label>
              <select
                id="ct-type"
                aria-label="Content type"
                value={type}
                onChange={(e) => setType(e.target.value as LmsContentType)}
                className={sel}
              >
                {(Object.keys(TYPE_LABEL) as LmsContentType[]).map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </div>
            <div className="grow space-y-1.5">
              <Label htmlFor="ct-title">Title</Label>
              <Input
                id="ct-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Photosynthesis"
                required
              />
            </div>
          </div>

          {type === "LESSON" && (
            <div className="space-y-1.5">
              <Label htmlFor="ct-html">Lesson body</Label>
              <Textarea
                id="ct-html"
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                rows={6}
                placeholder="Lesson content (HTML allowed)…"
              />
            </div>
          )}

          {type === "FORUM_THREAD" && (
            <div className="space-y-1.5">
              <Label htmlFor="ct-intro">Opening message</Label>
              <Textarea
                id="ct-intro"
                value={intro}
                onChange={(e) => setIntro(e.target.value)}
                rows={4}
                placeholder="Start the discussion…"
              />
            </div>
          )}

          {type === "MATERIAL" && (
            <div className="space-y-1.5">
              <Label htmlFor="ct-desc">Description</Label>
              <Textarea
                id="ct-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Describe the file. You can attach the PDF after saving."
              />
            </div>
          )}

          {type === "QUIZ" && <QuizBuilder questions={questions} setQuestions={setQuestions} />}

          <Button type="submit" size="sm">
            Create draft
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// --- quiz builder -----------------------------------------------------------
function QuizBuilder({
  questions,
  setQuestions,
}: {
  questions: QuizQuestionDto[];
  setQuestions: React.Dispatch<React.SetStateAction<QuizQuestionDto[]>>;
}) {
  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

  const add = () =>
    setQuestions((qs) => [
      ...qs,
      {
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `q${Date.now()}_${qs.length}`,
        type: "MCQ",
        prompt: "",
        options: ["", ""],
        answer: "0",
        points: 1,
      },
    ]);

  const update = (id: string, patch: Partial<QuizQuestionDto>) =>
    setQuestions((qs) => qs.map((q) => (q.id === id ? { ...q, ...patch } : q)));

  const remove = (id: string) => setQuestions((qs) => qs.filter((q) => q.id !== id));

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <Label>Questions</Label>
        <Button type="button" size="sm" variant="outline" onClick={add}>
          Add question
        </Button>
      </div>

      {questions.length === 0 && (
        <p className="text-sm text-muted-foreground">No questions yet.</p>
      )}

      {questions.map((q, i) => (
        <div key={q.id} className="space-y-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <span className="text-sm font-medium">Q{i + 1}</span>
            <select
              aria-label="Question type"
              value={q.type}
              onChange={(e) => {
                const t = e.target.value as QuizQuestionDto["type"];
                update(q.id, {
                  type: t,
                  options: t === "MCQ" ? (q.options ?? ["", ""]) : undefined,
                  answer: t === "TF" ? "true" : t === "MCQ" ? "0" : "",
                });
              }}
              className={sel}
            >
              <option value="MCQ">Multiple choice</option>
              <option value="TF">True / false</option>
              <option value="SHORT">Short answer</option>
            </select>
            <Button type="button" size="sm" variant="ghost" onClick={() => remove(q.id)}>
              Remove
            </Button>
          </div>

          <Input
            value={q.prompt}
            onChange={(e) => update(q.id, { prompt: e.target.value })}
            placeholder="Question prompt"
          />

          {q.type === "MCQ" && (
            <div className="space-y-2">
              {(q.options ?? []).map((opt, oi) => (
                <div key={oi} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`ans-${q.id}`}
                    checked={q.answer === String(oi)}
                    onChange={() => update(q.id, { answer: String(oi) })}
                    aria-label={`Mark option ${oi + 1} correct`}
                  />
                  <Input
                    value={opt}
                    onChange={(e) =>
                      update(q.id, {
                        options: (q.options ?? []).map((o, j) => (j === oi ? e.target.value : o)),
                      })
                    }
                    placeholder={`Option ${oi + 1}`}
                  />
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => update(q.id, { options: [...(q.options ?? []), ""] })}
              >
                Add option
              </Button>
            </div>
          )}

          {q.type === "TF" && (
            <select
              aria-label="Correct answer"
              value={q.answer}
              onChange={(e) => update(q.id, { answer: e.target.value })}
              className={sel}
            >
              <option value="true">True</option>
              <option value="false">False</option>
            </select>
          )}

          {q.type === "SHORT" && (
            <Input
              value={q.answer}
              onChange={(e) => update(q.id, { answer: e.target.value })}
              placeholder="Exact expected answer"
            />
          )}
        </div>
      ))}
    </div>
  );
}
