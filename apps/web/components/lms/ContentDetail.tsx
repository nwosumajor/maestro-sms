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
  LmsSubmissionDto,
  QuizAttemptGradeDto,
  QuizAttemptResultDto,
  QuizDefDto,
  Serialized,
} from "@sms/types";
import * as React from "react";

/** Mirrors the server cap; the server re-checks both type and size. */
const MAX_MATERIAL_BYTES = 25 * 1024 * 1024;
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LessonBlocks } from "./LessonBlocks";

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
  priorResult,
  canQuiz,
  canPost,
  isStaff,
}: {
  content: Content;
  forum: Post[];
  priorResult: QuizAttemptResultDto | null;
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
        {body.kind === "LESSON" && <LessonBlocks blocks={body.blocks} />}

        {body.kind === "MATERIAL" && (
          <MaterialView
            contentId={content.id}
            description={body.description ?? null}
            fileName={content.fileName}
            isStaff={isStaff}
            locked={content.status !== "DRAFT" && content.status !== "REVISION_REQUESTED"}
          />
        )}

        {body.kind === "QUIZ" && (
          <QuizView
            contentId={content.id}
            quiz={body.quiz}
            canQuiz={canQuiz}
            isStaff={isStaff}
            priorResult={priorResult}
          />
        )}

        {body.kind === "FORUM_THREAD" && (
          <ForumView contentId={content.id} intro={body.intro} initial={forum} canPost={canPost} />
        )}

        {body.kind === "VIDEO" && (
          // The URL is a server-canonicalised, host-allowlisted embed (youtube-nocookie / vimeo).
          <div className="space-y-3">
            <div className="aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
              <iframe
                src={body.url}
                title={content.title}
                className="h-full w-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </div>
            {body.description && <p className="text-sm leading-relaxed text-muted-foreground">{body.description}</p>}
          </div>
        )}

        {body.kind === "ASSIGNMENT" && (
          <AssignmentView
            contentId={content.id}
            body={body}
            isStaff={isStaff}
            canSubmit={canQuiz}
            published={content.status === "PUBLISHED"}
          />
        )}

        {/* students may mark a published item complete (parents/staff can't — API 404s) */}
        {!isStaff && canQuiz && content.status === "PUBLISHED" && body.kind !== "ASSIGNMENT" && (
          <CompleteToggle contentId={content.id} initial={content.completed} />
        )}
      </CardContent>
    </Card>
  );
}

// --- completion toggle ------------------------------------------------------
function CompleteToggle({ contentId, initial }: { contentId: string; initial: boolean }) {
  const [done, setDone] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const toggle = async () => {
    setBusy(true);
    const res = await fetch(`/api/sms/content/${contentId}/complete`, { method: done ? "DELETE" : "POST" });
    setBusy(false);
    if (res.ok) setDone((d) => !d);
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3">
      <span className="text-sm text-muted-foreground">
        {done ? "You've marked this complete." : "Finished with this? Mark it complete."}
      </span>
      <Button size="sm" variant={done ? "outline" : "default"} disabled={busy} onClick={toggle}>
        {done ? "✓ Completed" : "Mark complete"}
      </Button>
    </div>
  );
}

// --- assignment -------------------------------------------------------------
type Submission = Serialized<LmsSubmissionDto>;
type AssignmentBody = Extract<Serialized<LmsContentBody>, { kind: "ASSIGNMENT" }>;

function AssignmentView({
  contentId,
  body,
  isStaff,
  canSubmit,
  published,
}: {
  contentId: string;
  body: AssignmentBody;
  isStaff: boolean;
  canSubmit: boolean;
  published: boolean;
}) {
  const due = body.dueAt ? new Date(body.dueAt) : null;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4">
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{body.instructions}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          {body.points ? `Marked out of ${body.points}. ` : ""}
          {due ? `Due ${due.toISOString().slice(0, 10)}.` : "No due date."}
          {body.allowLate ? " Late submissions allowed." : ""}
        </p>
      </div>
      {isStaff ? (
        <TeacherSubmissions contentId={contentId} points={body.points ?? null} />
      ) : canSubmit && published ? (
        <StudentSubmit contentId={contentId} points={body.points ?? null} />
      ) : null}
    </div>
  );
}

function StudentSubmit({ contentId, points }: { contentId: string; points: number | null }) {
  const [sub, setSub] = React.useState<Submission | null>(null);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  React.useEffect(() => {
    (async () => {
      const res = await fetch(`/api/sms/content/${contentId}/submission/me`);
      if (!res.ok) return;
      const raw = await res.text(); // API returns an empty body for "no submission yet"
      const s = raw ? (JSON.parse(raw) as Submission) : null;
      if (s) { setSub(s); setText(s.text); }
    })();
  }, [contentId]);
  const graded = sub?.status === "GRADED";
  const submit = async () => {
    setBusy(true); setMsg(null);
    const res = await post<Submission>(`/content/${contentId}/submission`, { text });
    setBusy(false);
    if (res.ok && res.data) { setSub(res.data); setMsg("Submitted."); }
    else setMsg(res.error ?? "Failed.");
  };
  return (
    <div className="space-y-3">
      {sub && (
        <p className="text-sm">
          <Badge variant={graded ? "default" : "secondary"}>{graded ? "Graded" : "Submitted"}</Badge>
          {sub.late && <Badge variant="destructive" className="ml-2">Late</Badge>}
          {graded && (
            <span className="ml-2 font-medium">
              {sub.grade}
              {points != null ? `/${points}` : ""}
            </span>
          )}
        </p>
      )}
      {graded ? (
        <>
          <div className="rounded-md border border-border bg-background p-3 text-sm">
            <p className="text-xs font-medium text-muted-foreground">Your submission</p>
            <p className="mt-1 whitespace-pre-wrap">{sub?.text}</p>
          </div>
          {sub?.feedback && (
            <div className="rounded-md border border-primary/25 bg-primary/5 p-3 text-sm">
              <p className="text-xs font-medium text-primary">Teacher feedback</p>
              <p className="mt-1 whitespace-pre-wrap">{sub.feedback}</p>
            </div>
          )}
        </>
      ) : (
        <>
          <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your submission…" />
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={busy || !text.trim()} onClick={submit}>
              {sub ? "Update submission" : "Submit"}
            </Button>
            {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
          </div>
        </>
      )}
    </div>
  );
}

function TeacherSubmissions({ contentId, points }: { contentId: string; points: number | null }) {
  const [subs, setSubs] = React.useState<Submission[] | null>(null);
  const load = React.useCallback(async () => {
    const res = await fetch(`/api/sms/content/${contentId}/submissions`);
    if (res.ok) setSubs((await res.json()) as Submission[]);
  }, [contentId]);
  React.useEffect(() => { void load(); }, [load]);
  if (!subs) return <p className="text-sm text-muted-foreground">Loading submissions…</p>;
  if (subs.length === 0) return <p className="text-sm text-muted-foreground">No submissions yet.</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{subs.length} submission{subs.length === 1 ? "" : "s"}</p>
      {subs.map((s) => (
        <GradeRow key={s.id} sub={s} points={points} onGraded={load} />
      ))}
    </div>
  );
}

function GradeRow({ sub, points, onGraded }: { sub: Submission; points: number | null; onGraded: () => void }) {
  const [grade, setGrade] = React.useState(sub.grade != null ? String(sub.grade) : "");
  const [feedback, setFeedback] = React.useState(sub.feedback ?? "");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const save = async () => {
    setBusy(true); setMsg(null);
    const res = await post<Submission>(`/submissions/${sub.id}/grade`, { grade: Number(grade), feedback });
    setBusy(false);
    if (res.ok) { setMsg("Saved."); onGraded(); } else setMsg(res.error ?? "Failed.");
  };
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{sub.studentName}</span>
        <Badge variant={sub.status === "GRADED" ? "default" : "secondary"}>{sub.status.toLowerCase()}</Badge>
        {sub.late && <Badge variant="destructive">late</Badge>}
      </div>
      <p className="mt-2 whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 p-2.5 text-sm">{sub.text}</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Grade{points != null ? ` (/${points})` : ""}</label>
          <Input type="number" min={0} max={points ?? undefined} className="w-24" value={grade} onChange={(e) => setGrade(e.target.value)} />
        </div>
        <Input className="min-w-[12rem] flex-1" value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Feedback (optional)" />
        <Button size="sm" disabled={busy || grade === ""} onClick={save}>Save grade</Button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
    </div>
  );
}

// --- material ---------------------------------------------------------------
function MaterialView({
  contentId,
  description,
  fileName,
  isStaff,
  locked,
}: {
  contentId: string;
  description: string | null;
  fileName: string | null;
  isStaff: boolean;
  locked: boolean;
}) {
  const [name, setName] = React.useState(fileName);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // GET, matching the route. This called POST and therefore 404'd on every
  // click — so the pupil-facing Download button had never worked, on a feature
  // whose whole purpose is that pupils can read the file.
  const download = async () => {
    const res = await fetch(`/api/sms/content/${contentId}/download`);
    if (!res.ok) {
      setMsg(res.status === 404 ? "No file available." : "Could not open the file.");
      return;
    }
    const { url } = (await res.json()) as { url: string };
    window.open(url, "_blank", "noopener");
  };

  // presign -> PUT the bytes straight to storage -> confirm. Same three steps
  // as the Document Vault and the submission uploader; the bytes never pass
  // through the API. The endpoints existed already and nothing called them, so
  // a teacher could not attach a PDF at all.
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const clear = () => { if (inputRef.current) inputRef.current.value = ""; };
    if (file.type !== "application/pdf") {
      setMsg("Please choose a PDF — that is what pupils can open in the browser.");
      clear();
      return;
    }
    if (file.size > MAX_MATERIAL_BYTES) {
      setMsg(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_MATERIAL_BYTES / 1024 / 1024} MB.`);
      clear();
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const pres = await post<{ url: string }>(`/content/${contentId}/upload`, {
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      });
      if (!pres.ok || !pres.data?.url) throw new Error(pres.error ?? "Could not start the upload.");
      const put = await fetch(pres.data.url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!put.ok) throw new Error(`The file did not reach storage (${put.status}).`);
      const conf = await post(`/content/${contentId}/upload/confirm`);
      if (!conf.ok) throw new Error(conf.error ?? "Uploaded, but confirming it failed.");
      setName(file.name);
      setMsg("Attached. Pupils see it once this material is published.");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
      clear();
    }
  };

  return (
    <div className="space-y-3">
      {description && <p className="text-sm">{description}</p>}
      {name ? (
        <Button size="sm" onClick={download}>
          Download {name}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          {isStaff ? "No PDF attached yet." : "No file attached yet."}
        </p>
      )}

      {/* Staff only, and only while the material can still be edited — after
          submission it is awaiting approval, and swapping the file underneath a
          reviewer would mean they approved something else. */}
      {isStaff && (
        <div className="rounded-md border border-border p-3">
          <p className="text-sm font-medium">{name ? "Replace the PDF" : "Attach a PDF for pupils to read"}</p>
          <p className="text-xs text-muted-foreground">
            {locked
              ? "Locked while this is awaiting approval. Request a revision to change it."
              : `PDF only, up to ${MAX_MATERIAL_BYTES / 1024 / 1024} MB. Pupils taking this subject can open it once published.`}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input aria-label="Choose a PDF to attach" ref={inputRef} type="file" accept="application/pdf" className="hidden" onChange={onPick} disabled={busy || locked} />
            <Button type="button" size="sm" variant="outline" disabled={busy || locked} onClick={() => inputRef.current?.click()}>
              {busy ? "Uploading…" : name ? "Choose a different PDF" : "Choose PDF"}
            </Button>
          </div>
        </div>
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
  priorResult,
}: {
  contentId: string;
  quiz: QuizDefDto;
  canQuiz: boolean;
  isStaff: boolean;
  priorResult: QuizAttemptResultDto | null;
}) {
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [result, setResult] = React.useState<QuizAttemptResultDto | null>(priorResult);
  const [error, setError] = React.useState<string | null>(null);
  const [retaking, setRetaking] = React.useState(false);
  const questions = quiz.questions ?? [];
  const now = Date.now();
  const opensAt = quiz.opensAt ? new Date(quiz.opensAt) : null;
  const closesAt = quiz.closesAt ? new Date(quiz.closesAt) : null;
  const windowOpen = (!opensAt || now >= opensAt.getTime()) && (!closesAt || now <= closesAt.getTime());
  const maxAttempts = result?.maxAttempts ?? quiz.maxAttempts ?? 1;
  const attemptsUsed = result?.attemptsUsed ?? 0;
  const canRetake = !!result && attemptsUsed < maxAttempts && windowOpen;
  // The form is read-only once a result is shown, unless the student is retaking.
  const locked = !!result && !retaking;

  const submit = async () => {
    setError(null);
    const r = await post<QuizAttemptResultDto>(`/content/${contentId}/quiz/attempt`, { answers });
    if (r.ok && r.data) { setResult(r.data); setRetaking(false); }
    else setError(r.error ?? "Could not submit.");
  };
  const retake = () => { setAnswers({}); setRetaking(true); setError(null); };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {questions.length} question{questions.length === 1 ? "" : "s"}.
        {isStaff ? " You are viewing the answer key." : ` Attempts: ${attemptsUsed}/${maxAttempts}.`}
        {quiz.timeLimitMinutes ? ` Time limit ${quiz.timeLimitMinutes} min.` : ""}
        {closesAt ? ` Closes ${closesAt.toISOString().slice(0, 16).replace("T", " ")} UTC.` : ""}
        {!isStaff && !windowOpen && (opensAt && now < opensAt.getTime() ? " Not open yet." : " Closed.")}
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
                  disabled={isStaff || locked}
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
                  disabled={isStaff || locked}
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
                disabled={locked}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                placeholder="Your answer"
              />
            ))}

          {q.type === "ESSAY" &&
            (isStaff ? (
              <p className="text-sm text-muted-foreground">Essay — marked by hand ({q.points ?? 1} marks).</p>
            ) : (
              <Textarea
                disabled={locked}
                rows={4}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                placeholder="Write your response"
              />
            ))}
        </div>
      ))}

      {!isStaff && canQuiz && !locked && windowOpen && (
        <Button size="sm" onClick={submit}>
          Submit answers
        </Button>
      )}

      {result && !retaking && (
        <div className="space-y-2">
          <Alert score={result.score} total={result.total} />
          {result.pendingManual && (
            <p className="text-xs text-muted-foreground">
              Your objective answers are marked; the essay question(s) are awaiting your teacher.
            </p>
          )}
          {canRetake && (
            <Button size="sm" variant="outline" onClick={retake}>
              Retake ({maxAttempts - attemptsUsed} left)
            </Button>
          )}
        </div>
      )}
      {isStaff && <QuizGrading contentId={contentId} />}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

// --- teacher essay grading --------------------------------------------------
type AttemptGrade = Serialized<QuizAttemptGradeDto>;

function QuizGrading({ contentId }: { contentId: string }) {
  const [attempts, setAttempts] = React.useState<AttemptGrade[] | null>(null);
  const load = React.useCallback(async () => {
    const res = await fetch(`/api/sms/content/${contentId}/attempts`);
    if (res.ok) setAttempts((await res.json()) as AttemptGrade[]);
  }, [contentId]);
  React.useEffect(() => { void load(); }, [load]);
  if (!attempts) return null;
  const withEssays = attempts.filter((a) => a.essays.length > 0);
  if (withEssays.length === 0) return null;
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <p className="text-sm font-semibold">Mark essay answers ({withEssays.length})</p>
      {withEssays.map((a) => (
        <EssayGradeRow key={a.attemptId} a={a} onGraded={load} />
      ))}
    </div>
  );
}

function EssayGradeRow({ a, onGraded }: { a: AttemptGrade; onGraded: () => void }) {
  const [grades, setGrades] = React.useState<Record<string, string>>(
    Object.fromEntries(a.essays.map((e) => [e.questionId, e.grade != null ? String(e.grade) : ""])),
  );
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    const payload: Record<string, number> = {};
    for (const [k, v] of Object.entries(grades)) if (v !== "") payload[k] = Number(v);
    const r = await post<AttemptGrade>(`/attempts/${a.attemptId}/grade-essays`, { grades: payload });
    setBusy(false);
    if (r.ok) { setMsg("Saved."); onGraded(); } else setMsg(r.error ?? "Failed.");
  };
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{a.studentName}</span>
        <Badge variant={a.status === "GRADED" ? "default" : "secondary"}>
          {a.status === "GRADED" ? "graded" : "pending"}
        </Badge>
        <span className="text-xs text-muted-foreground">
          score {a.score}/{a.total}
        </span>
      </div>
      {a.essays.map((e) => (
        <div key={e.questionId} className="mt-3 space-y-1.5">
          <p className="text-sm font-medium">{e.prompt}</p>
          <p className="whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 p-2.5 text-sm">
            {e.answer || "(no answer)"}
          </p>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Mark (/{e.points})</span>
            <Input
              type="number"
              min={0}
              max={e.points}
              className="w-24"
              value={grades[e.questionId] ?? ""}
              onChange={(ev) => setGrades((g) => ({ ...g, [e.questionId]: ev.target.value }))}
            />
          </div>
        </div>
      ))}
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={save}>Save marks</Button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
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
