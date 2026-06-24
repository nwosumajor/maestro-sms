"use client";

// =============================================================================
// ContentDetail — read/take/discuss one LMS content item (client)
// =============================================================================
// Renders by content type. The API is authoritative: students only ever receive
// PUBLISHED items with quiz answer keys stripped, grading is server-side, and the
// one-attempt rule + forum membership are re-checked on POST. Lesson HTML is
// authored by staff AND approval-gated by a principal before publication, so it
// is rendered as markup; nothing here trusts client state for access.
// =============================================================================

import type {
  ForumPostDto,
  LmsContentBody,
  LmsContentDto,
  QuizAttemptResultDto,
  QuizDefDto,
  Serialized,
} from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Content = Serialized<LmsContentDto>;
type Post = Serialized<ForumPostDto>;

async function post<T = unknown>(
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; data: T | null; error: string | null }> {
  const res = await fetch(`/api/sms${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.ok) return { ok: true, data: text ? (JSON.parse(text) as T) : null, error: null };
  let error = `Failed (${res.status}).`;
  try {
    const j = JSON.parse(text) as { message?: string | string[] };
    if (j.message) error = Array.isArray(j.message) ? j.message.join(", ") : j.message;
  } catch {
    /* keep generic */
  }
  return { ok: false, data: null, error };
}

export function ContentDetail({
  content,
  forum,
  canQuiz,
  canPost,
  isStaff,
}: {
  content: Content;
  forum: Post[];
  canQuiz: boolean;
  canPost: boolean;
  isStaff: boolean;
}) {
  const body = content.body as Serialized<LmsContentBody>;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>{content.title}</CardTitle>
          <CardDescription>by {content.authorName}</CardDescription>
        </div>
        <Badge variant={content.status === "PUBLISHED" ? "default" : "outline"}>
          {content.status.replace(/_/g, " ").toLowerCase()}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {body.kind === "LESSON" && (
          // SECURITY: staff-authored AND principal-approved before publication;
          // rendered as markup intentionally. Non-approved content never reaches a student.
          <div
            className="prose prose-sm max-w-none dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: body.html }}
          />
        )}

        {body.kind === "MATERIAL" && (
          <MaterialView contentId={content.id} description={body.description ?? null} fileName={content.fileName} />
        )}

        {body.kind === "QUIZ" && (
          <QuizView contentId={content.id} quiz={body.quiz} canQuiz={canQuiz} isStaff={isStaff} />
        )}

        {body.kind === "FORUM_THREAD" && (
          <ForumView contentId={content.id} intro={body.intro} initial={forum} canPost={canPost} />
        )}
      </CardContent>
    </Card>
  );
}

// --- material ---------------------------------------------------------------
function MaterialView({
  contentId,
  description,
  fileName,
}: {
  contentId: string;
  description: string | null;
  fileName: string | null;
}) {
  const [msg, setMsg] = React.useState<string | null>(null);

  const download = async () => {
    const r = await post<{ url: string }>(`/content/${contentId}/download`);
    if (r.ok && r.data?.url) window.open(r.data.url, "_blank", "noopener");
    else setMsg(r.error ?? "No file available.");
  };

  return (
    <div className="space-y-3">
      {description && <p className="text-sm">{description}</p>}
      {fileName ? (
        <Button size="sm" onClick={download}>
          Download {fileName}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">No file attached yet.</p>
      )}
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}

// --- quiz -------------------------------------------------------------------
function QuizView({
  contentId,
  quiz,
  canQuiz,
  isStaff,
}: {
  contentId: string;
  quiz: QuizDefDto;
  canQuiz: boolean;
  isStaff: boolean;
}) {
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [result, setResult] = React.useState<QuizAttemptResultDto | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const questions = quiz.questions ?? [];

  const submit = async () => {
    setError(null);
    const r = await post<QuizAttemptResultDto>(`/content/${contentId}/quiz/attempt`, { answers });
    if (r.ok && r.data) setResult(r.data);
    else setError(r.error ?? "Could not submit.");
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {questions.length} question{questions.length === 1 ? "" : "s"}.
        {isStaff ? " You are viewing the answer key." : " You may attempt this once."}
      </p>

      {questions.map((q, i) => (
        <div key={q.id} className="space-y-2 border-t border-border pt-3">
          <p className="text-sm font-medium">
            Q{i + 1}. {q.prompt}
          </p>

          {q.type === "MCQ" &&
            (q.options ?? []).map((opt, oi) => (
              <label key={oi} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`q-${q.id}`}
                  disabled={isStaff || !!result}
                  checked={answers[q.id] === String(oi)}
                  onChange={() => setAnswers((a) => ({ ...a, [q.id]: String(oi) }))}
                />
                {opt}
                {isStaff && q.answer === String(oi) && (
                  <Badge variant="secondary">correct</Badge>
                )}
              </label>
            ))}

          {q.type === "TF" &&
            ["true", "false"].map((v) => (
              <label key={v} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`q-${q.id}`}
                  disabled={isStaff || !!result}
                  checked={answers[q.id] === v}
                  onChange={() => setAnswers((a) => ({ ...a, [q.id]: v }))}
                />
                {v}
                {isStaff && q.answer === v && <Badge variant="secondary">correct</Badge>}
              </label>
            ))}

          {q.type === "SHORT" &&
            (isStaff ? (
              <p className="text-sm">
                Expected: <code>{q.answer}</code>
              </p>
            ) : (
              <Input
                disabled={!!result}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                placeholder="Your answer"
              />
            ))}
        </div>
      ))}

      {!isStaff && canQuiz && !result && (
        <Button size="sm" onClick={submit}>
          Submit answers
        </Button>
      )}

      {result && (
        <Alert score={result.score} total={result.total} />
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function Alert({ score, total }: { score: number; total: number }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
      You scored <span className="font-semibold">{score}</span> / {total}.
    </div>
  );
}

// --- forum ------------------------------------------------------------------
function ForumView({
  contentId,
  intro,
  initial,
  canPost,
}: {
  contentId: string;
  intro: string;
  initial: Post[];
  canPost: boolean;
}) {
  const [posts, setPosts] = React.useState<Post[]>(initial);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const text = draft.trim();
    if (!text) return;
    const r = await post<Post>(`/content/${contentId}/forum`, { body: text });
    if (r.ok && r.data) {
      setPosts((p) => [...p, r.data as Post]);
      setDraft("");
    } else {
      setError(r.error ?? "Could not post.");
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm">{intro}</p>

      <div className="space-y-2">
        {posts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No replies yet.</p>
        ) : (
          posts.map((p) => (
            <div key={p.id} className="rounded-md border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">{p.authorName}</p>
              <p className="text-sm">{p.body}</p>
            </div>
          ))
        )}
      </div>

      {canPost && (
        <form onSubmit={send} className="space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Write a reply…"
          />
          <Button type="submit" size="sm" disabled={!draft.trim()}>
            Post reply
          </Button>
        </form>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
