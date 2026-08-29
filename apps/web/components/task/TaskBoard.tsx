"use client";

// Task System UI. Managers/teachers (canAssign) create tasks + assign to staff/
// students and close them; assignees update their own status, attach a document,
// and either side posts follow-up comments.

import type { TaskDto, Serialized } from "@sms/types";
import { useFormat } from "@/components/shell/RegionProvider";
import { usePaged, type Paged } from "@/lib/paged";
import { LoadMore } from "@/components/shell/LoadMore";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { personLabel } from "@/lib/people";

type Task = Serialized<TaskDto>;
type Person = { id: string; name: string; roles?: string[] };

/**
 * A DUE DATE THAT HAS PASSED SAYS SO.
 *
 * The row rendered "due 3 Aug" in the same muted grey whether that was next week
 * or three weeks ago, so an overdue task looked exactly like a fresh one — the
 * shape this repo already fixed for the operator's onboarding queue, where a
 * lead submitted three weeks earlier was indistinguishable from this morning's.
 *
 * ONLY WHILE IT IS STILL OPEN. "Overdue" on a task somebody finished is a false
 * statement about their work, and it would teach a reader to ignore the marker
 * on the rows where it is true — the same reasoning the breach sweep uses for
 * sending at most two notices per incident.
 *
 * NO SWEEP, deliberately. This is a list a manager already reads; adding a timer
 * to chase what the screen can simply say is the more elaborate answer to the
 * smaller problem, exactly as the onboarding-lead fix concluded.
 */
export function isOverdue(dueAt: string, status: string, myStatus: string | null): boolean {
  if (status === "COMPLETED" || status === "CANCELLED") return false;
  // THE VIEWER'S OWN PART, not just the task's.
  //
  // The rule above was written as "said only while the task is OPEN — 'overdue'
  // on work somebody finished is a false statement about them, and it teaches a
  // reader to ignore the marker on the rows where it is true". Right rule,
  // applied to the wrong status: a task stays OPEN until the ASSIGNER closes it,
  // so an assignee who has finished kept being told their work was overdue.
  //
  // Driven live: assignee marks their part DONE -> task OPEN, myStatus DONE, and
  // the board still read "overdue — was due 1 Aug" to the person who did it.
  //
  // The ASSIGNER is deliberately unaffected — `myStatus` is null for them, and a
  // task with one of three assignees outstanding IS overdue from where they sit.
  // SUBMITTED counts as finished for this purpose: the assignee has handed it
  // over and what remains is somebody else's review.
  if (myStatus === "DONE" || myStatus === "SUBMITTED") return false;
  return new Date(dueAt).getTime() < Date.now();
}

export function TaskBoard({
  page, staff, students, canAssign,
}: {
  page: Paged<Task>; staff: Person[]; students: Person[]; canAssign: boolean;
}) {
  // Dates follow the SCHOOL's timezone, not the platform's.
  const { shortDate } = useFormat();
  const router = useRouter();
  const { items: tasks, hasMore, loading, loadMore } = usePaged<Task>(page, "tasks");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [desc, setDesc] = React.useState("");
  const [due, setDue] = React.useState("");
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [comment, setComment] = React.useState<Record<string, string>>({});
  // Categorised assignee picker: choose Staff or Students first, then tick names
  // from ONLY that category. Picks persist when switching categories, so one task
  // can still target both groups.
  const [category, setCategory] = React.useState<"STAFF" | "STUDENTS">("STAFF");
  const shown = category === "STAFF" ? staff : students;
  const names = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const u of [...staff, ...students]) m.set(u.id, u.name);
    return m;
  }, [staff, students]);

  const run = async (fn: () => Promise<{ ok: boolean; status: number; error: string | null }>, ok: string) => {
    setBusy(true); setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) { setMsg(ok); router.refresh(); } else setMsg(res.error ?? "Request failed.");
  };

  const togglePick = (id: string) => setPicked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      {canAssign && (
        <Card>
          <CardHeader><CardTitle className="text-base">Assign a task</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5"><Label>Title</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Due (optional)</Label><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
            </div>
            <div className="space-y-1.5"><Label>Description</Label><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} /></div>
            <div className="space-y-1.5">
              <Label>Assignees</Label>
              <div className="flex gap-1.5">
                {(["STAFF", "STUDENTS"] as const).map((c) => (
                  <Button key={c} type="button" size="sm" variant={category === c ? "default" : "outline"} onClick={() => setCategory(c)}>
                    {c === "STAFF" ? `Staff (${staff.length})` : `Students (${students.length})`}
                  </Button>
                ))}
              </div>
              <div className="flex max-h-48 flex-wrap gap-x-4 gap-y-1.5 overflow-y-auto rounded-md border border-border p-2">
                {shown.length === 0 && <span className="text-sm text-muted-foreground">No {category === "STAFF" ? "staff" : "students"} found.</span>}
                {shown.map((u) => (
                  <label key={u.id} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={picked.has(u.id)} onChange={() => togglePick(u.id)} />{personLabel(u)}
                  </label>
                ))}
              </div>
              {picked.size > 0 && (
                <p className="text-xs text-muted-foreground">
                  Assigning to: {[...picked].map((id) => names.get(id) ?? id).join(", ")}
                </p>
              )}
            </div>
            <Button disabled={busy || !title || picked.size === 0} onClick={() => run(() => postSms("tasks", { title, description: desc || undefined, dueAt: due ? new Date(due).toISOString() : undefined, assigneeIds: [...picked] }), "Task assigned.").then(() => { setTitle(""); setDesc(""); setDue(""); setPicked(new Set()); })}>Assign</Button>
          </CardContent>
        </Card>
      )}

      {tasks.length === 0 && <p className="text-sm text-muted-foreground">No tasks.</p>}

      {tasks.map((t) => (
        <Card key={t.id}>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              {t.title} <Badge variant={t.status === "COMPLETED" ? "outline" : "secondary"}>{t.status}</Badge>
              {t.dueAt &&
                (isOverdue(t.dueAt, t.status, t.myStatus) ? (
                  <span className="text-xs font-medium text-destructive">
                    overdue &mdash; was due {shortDate(t.dueAt)}
                  </span>
                ) : (
                  <span className="text-xs font-normal text-muted-foreground">due {shortDate(t.dueAt)}</span>
                ))}
            </CardTitle>
            <CardDescription>By {t.createdByName}{t.description ? ` · ${t.description}` : ""}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {t.assignees.map((a) => (
                <Badge key={a.id} variant="outline" className="font-normal">
                  {a.assigneeName}: {a.status}{a.hasAttachment ? " 📎" : ""}
                </Badge>
              ))}
            </div>

            {/* My own assignment controls */}
            {t.myStatus && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                <span className="text-xs text-muted-foreground">Your status:</span>
                {["IN_PROGRESS", "SUBMITTED", "DONE"].map((s) => (
                  <Button key={s} variant={t.myStatus === s ? "default" : "outline"} size="sm" disabled={busy} onClick={() => run(() => postSms(`tasks/${t.id}/me`, { status: s }), "Updated.")}>{s.replace("_", " ")}</Button>
                ))}
              </div>
            )}

            {/* Manager close */}
            {canAssign && t.createdById && t.status !== "COMPLETED" && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => postSms(`tasks/${t.id}/status`, { status: "COMPLETED" }), "Closed.")}>Mark complete</Button>
            )}

            {/* Comments */}
            <div className="space-y-1.5">
              {t.comments.map((c) => (
                <p key={c.id} className="text-sm"><span className="font-medium">{c.authorName}:</span> {c.body}</p>
              ))}
              <div className="flex gap-2">
                <Input value={comment[t.id] ?? ""} onChange={(e) => setComment((m) => ({ ...m, [t.id]: e.target.value }))} placeholder="Add a follow-up comment…" />
                <Button variant="outline" size="sm" disabled={busy || !(comment[t.id] ?? "").trim()} onClick={() => run(() => postSms(`tasks/${t.id}/comments`, { body: comment[t.id] }), "Commented.").then(() => setComment((m) => ({ ...m, [t.id]: "" })))}>Comment</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      <LoadMore hasMore={hasMore} loading={loading} onClick={loadMore} />
    </div>
  );
}
