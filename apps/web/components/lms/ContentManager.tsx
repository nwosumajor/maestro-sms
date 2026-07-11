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
  LessonBlock,
  LmsContentDto,
  LmsContentType,
  LmsModuleDto,
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
import { LessonBlockEditor } from "./LessonBlockEditor";
import { ContentItemTools } from "./ContentReuse";
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
  VIDEO: "Video",
  ASSIGNMENT: "Assignment",
  QUIZ: "Quiz",
  FORUM_THREAD: "Forum thread",
};

async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; error: string | null }> {
  const res = await fetch(`/api/sms${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
const post = (path: string, body?: unknown) => send("POST", path, body);

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

  const [modules, setModules] = React.useState<Serialized<LmsModuleDto>[]>([]);
  const loadModules = React.useCallback(async () => {
    const res = await fetch(`/api/sms/classes/${classId}/modules`);
    if (res.ok) setModules((await res.json()) as Serialized<LmsModuleDto>[]);
  }, [classId]);
  React.useEffect(() => { void loadModules(); }, [loadModules]);

  const act = async (label: string, fn: () => Promise<{ ok: boolean; error: string | null }>) => {
    const r = await fn();
    setMsg(r.ok ? label : r.error);
    if (r.ok) router.refresh();
  };

  // Group content into its modules (ordered), then a "General" bucket for the rest.
  const byModule = new Map<string, Content[]>();
  for (const c of initial) {
    const k = c.moduleId ?? "__general__";
    if (!byModule.has(k)) byModule.set(k, []);
    byModule.get(k)!.push(c);
  }
  const groups: { id: string | null; title: string; items: Content[] }[] = [
    ...modules.map((m) => ({ id: m.id, title: m.title, items: byModule.get(m.id) ?? [] })),
    { id: null, title: "General", items: byModule.get("__general__") ?? [] },
  ];

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

      {canAuthor && (
        <ModuleBar
          classId={classId}
          modules={modules}
          onChange={() => { void loadModules(); router.refresh(); }}
          setMsg={setMsg}
        />
      )}

      {initial.length === 0 ? (
        <p className="text-sm text-muted-foreground">No content yet.</p>
      ) : (
        <div className="space-y-6">
          {groups
            .filter((g) => g.items.length > 0 || (canAuthor && g.id !== null))
            .map((g) => (
              <div key={g.id ?? "general"} className="space-y-3">
                <div className="flex items-center gap-2.5 border-b border-border pb-2">
                  <h3 className="eyebrow text-foreground/80">{g.title}</h3>
                  <span className="tnum ml-auto text-xs text-muted-foreground">{g.items.length}</span>
                </div>
                {g.items.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No content in this module yet.</p>
                ) : (
                  g.items.map((c) => (
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
                            <Button size="sm" onClick={() => act("Published.", () => post(`/content/${c.id}/review`, { action: "APPROVE" }))}>
                              Approve &amp; publish
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => act("Revision requested.", () => post(`/content/${c.id}/review`, { action: "REQUEST_REVISION" }))}>
                              Request revision
                            </Button>
                            <Button size="sm" variant="destructive" onClick={() => act("Rejected.", () => post(`/content/${c.id}/review`, { action: "REJECT" }))}>
                              Reject
                            </Button>
                          </>
                        )}

                        {canAuthor && modules.length > 0 && (
                          <select
                            aria-label="Module"
                            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                            value={c.moduleId ?? ""}
                            onChange={(e) => act("Moved.", () => send("PUT", `/content/${c.id}/module`, { moduleId: e.target.value || null }))}
                          >
                            <option value="">General</option>
                            {modules.map((m) => (
                              <option key={m.id} value={m.id}>{m.title}</option>
                            ))}
                          </select>
                        )}

                        {canAuthor && (
                          <ContentItemTools
                            contentId={c.id}
                            editable={c.status === "DRAFT" || c.status === "REVISION_REQUESTED"}
                            onChanged={() => router.refresh()}
                          />
                        )}
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            ))}
        </div>
      )}

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}

// --- module bar -------------------------------------------------------------
function ModuleBar({
  classId,
  modules,
  onChange,
  setMsg,
}: {
  classId: string;
  modules: Serialized<LmsModuleDto>[];
  onChange: () => void;
  setMsg: (m: string) => void;
}) {
  const [title, setTitle] = React.useState("");
  const create = async () => {
    if (!title.trim()) return;
    const r = await send("POST", `/classes/${classId}/modules`, { title: title.trim() });
    if (r.ok) { setTitle(""); onChange(); } else setMsg(r.error ?? "Failed.");
  };
  const del = async (id: string) => {
    const r = await send("DELETE", `/modules/${id}`);
    if (r.ok) onChange(); else setMsg(r.error ?? "Failed.");
  };
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Modules</CardTitle>
        <CardDescription>
          Group content into an ordered learning path. Deleting a module keeps its content (moved to General).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {modules.length === 0 && <span className="text-xs text-muted-foreground">No modules yet.</span>}
          {modules.map((m) => (
            <span key={m.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs">
              {m.title}
              <button
                type="button"
                aria-label={`Delete ${m.title}`}
                className="text-sm leading-none text-muted-foreground hover:text-destructive"
                onClick={() => del(m.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New module title…" className="max-w-xs" />
          <Button size="sm" disabled={!title.trim()} onClick={create}>Add module</Button>
        </div>
      </CardContent>
    </Card>
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
  const [blocks, setBlocks] = React.useState<LessonBlock[]>([]);
  const [intro, setIntro] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [questions, setQuestions] = React.useState<QuizQuestionDto[]>([]);
  const [videoProvider, setVideoProvider] = React.useState<"YOUTUBE" | "VIMEO">("YOUTUBE");
  const [videoUrl, setVideoUrl] = React.useState("");
  const [instructions, setInstructions] = React.useState("");
  const [dueAt, setDueAt] = React.useState("");
  const [points, setPoints] = React.useState("");
  const [allowLate, setAllowLate] = React.useState(false);
  const [quizOpensAt, setQuizOpensAt] = React.useState("");
  const [quizClosesAt, setQuizClosesAt] = React.useState("");
  const [quizMaxAttempts, setQuizMaxAttempts] = React.useState("1");
  const [quizTimeLimit, setQuizTimeLimit] = React.useState("");
  const [quizScoring, setQuizScoring] = React.useState<"BEST" | "LATEST">("BEST");
  const [quizDrawCount, setQuizDrawCount] = React.useState("");
  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

  const reset = () => {
    setTitle("");
    setBlocks([]);
    setIntro("");
    setDescription("");
    setQuestions([]);
    setVideoUrl("");
    setInstructions("");
    setDueAt("");
    setPoints("");
    setAllowLate(false);
    setQuizOpensAt("");
    setQuizClosesAt("");
    setQuizMaxAttempts("1");
    setQuizTimeLimit("");
    setQuizScoring("BEST");
    setQuizDrawCount("");
  };

  const body = (): Record<string, unknown> | null => {
    switch (type) {
      case "MATERIAL":
        return { kind: "MATERIAL", description: description || undefined };
      case "LESSON":
        return blocks.length ? { kind: "LESSON", blocks } : null;
      case "FORUM_THREAD":
        return { kind: "FORUM_THREAD", intro };
      case "VIDEO":
        if (!videoUrl.trim()) return null;
        return { kind: "VIDEO", provider: videoProvider, url: videoUrl.trim(), description: description || undefined };
      case "ASSIGNMENT":
        if (!instructions.trim()) return null;
        return {
          kind: "ASSIGNMENT",
          instructions: instructions.trim(),
          dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
          points: points ? Number(points) : undefined,
          allowLate,
        };
      case "QUIZ":
        if (questions.length === 0) return null;
        return {
          kind: "QUIZ",
          quiz: {
            questions,
            opensAt: quizOpensAt ? new Date(quizOpensAt).toISOString() : undefined,
            closesAt: quizClosesAt ? new Date(quizClosesAt).toISOString() : undefined,
            maxAttempts: quizMaxAttempts ? Number(quizMaxAttempts) : undefined,
            timeLimitMinutes: quizTimeLimit ? Number(quizTimeLimit) : undefined,
            drawCount: quizDrawCount ? Number(quizDrawCount) : undefined,
            scoring: quizScoring,
          },
        };
      default:
        return null;
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const b = body();
    if (!title.trim()) return onError("Title is required.");
    if (!b)
      return onError(
        type === "VIDEO"
          ? "Paste a YouTube or Vimeo link."
          : type === "ASSIGNMENT"
            ? "Add assignment instructions."
            : "Add at least one quiz question.",
      );
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
              <Label>Lesson body</Label>
              <LessonBlockEditor blocks={blocks} onChange={setBlocks} />
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

          {type === "VIDEO" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ct-vprov">Source</Label>
                  <select
                    id="ct-vprov"
                    aria-label="Video source"
                    value={videoProvider}
                    onChange={(e) => setVideoProvider(e.target.value as "YOUTUBE" | "VIMEO")}
                    className={sel}
                  >
                    <option value="YOUTUBE">YouTube</option>
                    <option value="VIMEO">Vimeo</option>
                  </select>
                </div>
                <div className="grow space-y-1.5">
                  <Label htmlFor="ct-vurl">Video link</Label>
                  <Input
                    id="ct-vurl"
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    placeholder="Paste the YouTube or Vimeo link…"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ct-vdesc">Description (optional)</Label>
                <Textarea
                  id="ct-vdesc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder="What should students watch for?"
                />
              </div>
            </div>
          )}

          {type === "ASSIGNMENT" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="ct-instr">Instructions</Label>
                <Textarea
                  id="ct-instr"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={5}
                  placeholder="What should students do and submit?"
                />
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ct-due">Due date</Label>
                  <Input id="ct-due" type="date" className="w-44" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ct-points">Marks</Label>
                  <Input id="ct-points" type="number" min={1} className="w-24" value={points} onChange={(e) => setPoints(e.target.value)} placeholder="100" />
                </div>
                <label className="flex items-center gap-2 pb-2 text-sm">
                  <input type="checkbox" checked={allowLate} onChange={(e) => setAllowLate(e.target.checked)} />
                  Allow late submissions
                </label>
              </div>
            </div>
          )}

          {type === "QUIZ" && (
            <>
              <div className="flex flex-wrap items-end gap-3 rounded-md border border-border/60 p-3">
                <div className="space-y-1">
                  <Label className="text-xs">Opens</Label>
                  <Input type="datetime-local" className="w-52" value={quizOpensAt} onChange={(e) => setQuizOpensAt(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Closes</Label>
                  <Input type="datetime-local" className="w-52" value={quizClosesAt} onChange={(e) => setQuizClosesAt(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Attempts</Label>
                  <Input type="number" min={1} className="w-20" value={quizMaxAttempts} onChange={(e) => setQuizMaxAttempts(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Time limit (min)</Label>
                  <Input type="number" min={1} className="w-28" value={quizTimeLimit} onChange={(e) => setQuizTimeLimit(e.target.value)} placeholder="none" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Draw N</Label>
                  <Input type="number" min={1} className="w-20" value={quizDrawCount} onChange={(e) => setQuizDrawCount(e.target.value)} placeholder="all" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Scoring</Label>
                  <select className={sel} value={quizScoring} onChange={(e) => setQuizScoring(e.target.value as "BEST" | "LATEST")}>
                    <option value="BEST">Best attempt</option>
                    <option value="LATEST">Latest attempt</option>
                  </select>
                </div>
              </div>
              <QuizBuilder questions={questions} setQuestions={setQuestions} />
            </>
          )}

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
              <option value="ESSAY">Essay (marked by hand)</option>
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

          {q.type === "ESSAY" && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Marks</span>
              <Input
                type="number"
                min={1}
                className="w-20"
                value={String(q.points ?? 1)}
                onChange={(e) => update(q.id, { points: Number(e.target.value) || 1 })}
              />
              <span className="text-xs text-muted-foreground">
                Students type a response; you mark it after they submit.
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
