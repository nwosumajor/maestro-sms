"use client";

// Task System UI. Managers/teachers (canAssign) create tasks + assign to staff/
// students and close them; assignees update their own status, attach a document,
// and either side posts follow-up comments.

import type { TaskDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { shortDate } from "@/lib/format";
import { personLabel } from "@/lib/people";

type Task = Serialized<TaskDto>;
type Person = { id: string; name: string; roles?: string[] };

export function TaskBoard({
  tasks, staff, students, canAssign,
}: {
  tasks: Task[]; staff: Person[]; students: Person[]; canAssign: boolean;
}) {
  const router = useRouter();
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
              {t.dueAt && <span className="text-xs font-normal text-muted-foreground">due {shortDate(t.dueAt)}</span>}
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
    </div>
  );
}
