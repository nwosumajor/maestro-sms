"use client";

// =============================================================================
// Meeting requests — one panel, three audiences
// =============================================================================
// A parent asks; the TEACHER answers. Leadership sees everything and steps in
// on the exception (a concern, a decline, or a request nobody has answered).
//
// One component rather than three pages, because it is one list with different
// affordances: the API already returns only the rows this caller may see, so
// the page never has to decide who is who — it renders what it was given and
// shows the buttons that row allows.
// =============================================================================

import * as React from "react";
import { useFormat } from "@/components/shell/RegionProvider";
import { useRouter } from "next/navigation";
import type { MeetingRequestDto, MeetingRequestPageDto, Serialized } from "@sms/types";
import { MEETING_REQUEST_TOPICS, MEETING_REQUEST_TOPIC_LABELS } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { StudentPicker } from "@/components/people/StudentPicker";
import { readApiError } from "@/lib/api-error";


type Row = Serialized<MeetingRequestDto>;
type Page = Serialized<MeetingRequestPageDto>;
type Teacher = { id: string; name: string };

export function MeetingRequests({
  queue,
  history,
  canAsk,
  canAnswer,
  teachers = [],
}: {
  /** Those still awaiting an answer, OLDEST FIRST, filtered in SQL. */
  queue: Page;
  /** Those already answered, newest first. */
  history: Page;
  /** A parent: may open a request about their own child. */
  canAsk: boolean;
  /** A teacher or leadership: may answer one. */
  canAnswer: boolean;
  teachers?: Teacher[];
}) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({ studentId: "", teacherId: "", topic: "PROGRESS", note: "" });

  const send = async (path: string, body?: unknown, method: "POST" | "DELETE" = "POST") => {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/sms/meetings/${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusy(false);
    if (res.ok) {
      router.refresh();
      return true;
    }
    setMsg(await readApiError(res));
    return false;
  };

  // // GOTCHA: this used to be `requests.filter(...)` over a `take: 200`
  // newest-first slice, while the API had always been able to narrow to the
  // open ones in SQL and this — its only caller — never asked. A request is
  // waiting precisely because nobody has answered it, so the waiting ones age
  // off the end of a newest-first cap: the rows the split existed to surface
  // were the rows it could not see.
  const open = queue.items;
  const done = history.items;
  const waiting = queue.pendingTotal;

  return (
    <div className="space-y-4">
      {canAsk && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Ask a teacher for a meeting</CardTitle>
            <CardDescription>
              The teacher answers directly — they choose a time and it appears in your meetings. A concern is sent to
              the school office first.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Which child</Label>
                <StudentPicker
                  value={form.studentId}
                  onChange={(id: string) => setForm({ ...form, studentId: id })}
                  placeholder="Search your child…"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mr-teacher">Which teacher</Label>
                {/* Chosen from the staff who actually teach this school, and the
                    server re-checks that they teach THIS child — so a typo
                    cannot address a stranger. */}
                <select
                  id="mr-teacher"
                  value={form.teacherId}
                  onChange={(e) => setForm({ ...form, teacherId: e.target.value })}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Choose a teacher…</option>
                  {teachers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-topic">What it is about</Label>
              <select
                id="mr-topic"
                value={form.topic}
                onChange={(e) => setForm({ ...form, topic: e.target.value })}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-72"
              >
                {MEETING_REQUEST_TOPICS.map((t) => (
                  <option key={t} value={t}>
                    {MEETING_REQUEST_TOPIC_LABELS[t]}
                  </option>
                ))}
              </select>
              {/* Say where it goes, before it goes. A concern reaching the
                  teacher it may be about is the thing to avoid. */}
              <p className="text-xs text-muted-foreground">
                {form.topic === "CONCERN"
                  ? "This goes to the school office first, not to the teacher."
                  : "This goes straight to the teacher."}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-note">Anything to add (optional)</Label>
              <Input
                id="mr-note"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="What you would like to discuss"
              />
            </div>
            <Button
              size="sm"
              disabled={busy || !form.studentId || !form.teacherId}
              onClick={async () => {
                if (await send("requests", { ...form, note: form.note || null })) {
                  setForm({ studentId: "", teacherId: "", topic: "PROGRESS", note: "" });
                  setMsg("Request sent.");
                }
              }}
            >
              {busy ? "Sending…" : "Send request"}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Meeting requests</CardTitle>
          <CardDescription>
            {waiting === 0
              ? "Nothing waiting."
              : `${waiting} waiting for an answer${
                  queue.total > open.length ? ` — showing the ${open.length} that have waited longest` : ""
                }.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {open.length === 0 && done.length === 0 && (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          )}
          {[...open, ...done].map((r) => (
            <RequestRow key={r.id} r={r} canAnswer={canAnswer} busy={busy} send={send} />
          ))}
          {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function RequestRow({
  r,
  canAnswer,
  busy,
  send,
}: {
  r: Row;
  canAnswer: boolean;
  busy: boolean;
  send: (path: string, body?: unknown, method?: "POST" | "DELETE") => Promise<boolean>;
}) {
  // Dates follow the SCHOOL's timezone, not the platform's.
  const { dateTime } = useFormat();
  const [when, setWhen] = React.useState({ date: "", start: "15:00", end: "15:30" });
  const [note, setNote] = React.useState("");
  const [openForm, setOpenForm] = React.useState(false);

  const waiting = r.status === "PENDING_APPROVAL" || r.status === "PENDING_TEACHER";

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {r.studentName} <span className="text-muted-foreground">· {r.topicLabel}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {r.parentName} → {r.teacherName} · asked {dateTime(r.createdAt)}
          </p>
          {r.note && <p className="mt-1 text-sm">{r.note}</p>}
          {r.decisionNote && (
            <p className="mt-1 text-sm text-muted-foreground">
              {r.decidedByName ? `${r.decidedByName}: ` : ""}
              {r.decisionNote}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Stale is not decoration: the teacher is the only approver, so a
              request nobody looks at leaves the parent waiting with no signal. */}
          {r.stale && <Badge variant="destructive">Waiting {">"}3 days</Badge>}
          <Badge variant={r.status === "ACCEPTED" ? "default" : waiting ? "secondary" : "outline"}>
            {r.statusLabel}
          </Badge>
        </div>
      </div>

      {canAnswer && waiting && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {r.status === "PENDING_APPROVAL" ? (
            <div className="flex flex-wrap items-end gap-2">
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note (optional)"
                className="h-9 w-full sm:w-64"
              />
              <Button size="sm" disabled={busy} onClick={() => send(`requests/${r.id}/review`, { action: "PASS", note })}>
                Pass to the teacher
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => send(`requests/${r.id}/review`, { action: "DECLINE", note })}
              >
                Decline
              </Button>
            </div>
          ) : openForm ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1"><Label className="text-xs">Date</Label>
                <Input type="date" value={when.date} onChange={(e) => setWhen({ ...when, date: e.target.value })} className="h-9 w-40" /></div>
              <div className="space-y-1"><Label className="text-xs">From</Label>
                <Input type="time" value={when.start} onChange={(e) => setWhen({ ...when, start: e.target.value })} className="h-9 w-28" /></div>
              <div className="space-y-1"><Label className="text-xs">To</Label>
                <Input type="time" value={when.end} onChange={(e) => setWhen({ ...when, end: e.target.value })} className="h-9 w-28" /></div>
              <Button
                size="sm"
                disabled={busy || !when.date}
                onClick={() =>
                  send(`requests/${r.id}/decide`, {
                    action: "ACCEPT",
                    startsAt: new Date(`${when.date}T${when.start}:00`).toISOString(),
                    endsAt: new Date(`${when.date}T${when.end}:00`).toISOString(),
                  })
                }
              >
                Confirm the meeting
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setOpenForm(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <Button size="sm" disabled={busy} onClick={() => setOpenForm(true)}>
                Accept — choose a time
              </Button>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why not? (required to decline)"
                className="h-9 w-full sm:w-64"
              />
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || !note.trim()}
                onClick={() => send(`requests/${r.id}/decide`, { action: "DECLINE", note })}
              >
                Decline
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
