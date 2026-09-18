"use client";

// =============================================================================
// LiveSessions — scheduled live/virtual classes for a class (client island)
// =============================================================================
// Everyone on the class page sees the schedule; the "Join" button asks the API
// for the URL (which records attendance + gates the join window server-side).
// Staff/host additionally get a create form, status controls, and the attendance
// register. The API is authoritative for scope, the join window, and URL safety.
// =============================================================================

import type { LmsLiveAttendanceDto, LmsLiveSessionDto, Serialized } from "@sms/types";
import { MAX_RECORDING_BYTES } from "@sms/types";
import { interpretApiError } from "@/lib/api-error";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Session = Serialized<LmsLiveSessionDto>;
type Attendee = Serialized<LmsLiveAttendanceDto>;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  LIVE: "default",
  SCHEDULED: "secondary",
  ENDED: "outline",
  CANCELLED: "destructive",
};

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`/api/sms${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  const data = raw ? JSON.parse(raw) : null;
  if (res.ok) return { ok: true as const, data };
  const j = data as { message?: string | string[] } | null;
  const error = interpretApiError(res.status, Array.isArray(j?.message) ? j.message.join(", ") : j?.message);
  return { ok: false as const, error };
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function LiveSessions({ classId, canManage }: { classId: string; canManage: boolean }) {
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [err, setErr] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  const load = React.useCallback(async () => {
    const r = await req("GET", `/classes/${classId}/live`);
    if (r.ok) setSessions(r.data as Session[]);
    else setErr(r.error);
    setLoaded(true);
  }, [classId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function join(id: string) {
    setErr(null);
    const r = await req("POST", `/live/${id}/join`);
    if (r.ok) {
      window.open((r.data as { joinUrl: string }).joinUrl, "_blank", "noopener,noreferrer");
      void load();
    } else setErr(r.error);
  }

  async function setStatus(id: string, status: string) {
    setErr(null);
    const r = await req("PUT", `/live/${id}`, { status });
    if (r.ok) void load();
    else setErr(r.error);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Live classes</CardTitle>
        <CardDescription>Scheduled virtual sessions. Joining opens the meeting and marks your attendance.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canManage && <CreateForm classId={classId} onCreated={load} />}

        {loaded && sessions.length === 0 && <p className="text-sm text-muted-foreground">No live classes scheduled.</p>}

        {sessions.map((s) => (
          <div key={s.id} className="rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.title}</span>
              <Badge variant="outline">{s.provider}</Badge>
              <Badge variant={STATUS_VARIANT[s.status] ?? "outline"}>{s.status.toLowerCase()}</Badge>
              <span className="text-sm text-muted-foreground">
                {when(s.startsAt)} · {s.durationMinutes}m · host {s.hostName}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button size="sm" disabled={!s.joinable} onClick={() => join(s.id)}>
                  {s.joinable ? "Join" : "Not open"}
                </Button>
              </div>
            </div>
            {canManage && (
              <div className="mt-2 flex flex-wrap items-center gap-1 border-t pt-2 text-xs">
                <span className="text-muted-foreground">{s.attendeeCount} joined ·</span>
                {s.status !== "LIVE" && s.status !== "CANCELLED" && (
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => setStatus(s.id, "LIVE")}>
                    Mark live
                  </Button>
                )}
                {s.status !== "ENDED" && s.status !== "CANCELLED" && (
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => setStatus(s.id, "ENDED")}>
                    End
                  </Button>
                )}
                {s.status !== "CANCELLED" && s.status !== "ENDED" && (
                  <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={() => setStatus(s.id, "CANCELLED")}>
                    Cancel
                  </Button>
                )}
                <Attendance sessionId={s.id} />
                <RecordingControl session={s} onChanged={load} />
              </div>
            )}
          </div>
        ))}
        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}

function CreateForm({ classId, onCreated }: { classId: string; onCreated: () => void }) {
  const [title, setTitle] = React.useState("");
  const [provider, setProvider] = React.useState("MEET");
  const [joinUrl, setJoinUrl] = React.useState("");
  const [startsAt, setStartsAt] = React.useState("");
  const [duration, setDuration] = React.useState("60");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";

  async function submit() {
    if (!title.trim() || !joinUrl.trim() || !startsAt) return;
    setBusy(true);
    setErr(null);
    const r = await req("POST", `/classes/${classId}/live`, {
      title: title.trim(),
      provider,
      joinUrl: joinUrl.trim(),
      startsAt: new Date(startsAt).toISOString(),
      durationMinutes: Number(duration) || 60,
    });
    setBusy(false);
    if (r.ok) {
      setTitle("");
      setJoinUrl("");
      setStartsAt("");
      onCreated();
    } else setErr(r.error);
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Title</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Algebra revision" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Provider</Label>
          <select aria-label="Provider" className={sel + " w-full"} value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="MEET">Google Meet</option>
            <option value="ZOOM">Zoom</option>
            <option value="JITSI">Jitsi</option>
            <option value="OTHER">Other (https)</option>
          </select>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Join link (https)</Label>
          <Input value={joinUrl} onChange={(e) => setJoinUrl(e.target.value)} placeholder="https://meet.google.com/…" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Starts</Label>
          <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Duration (min)</Label>
          <Input type="number" min={1} value={duration} onChange={(e) => setDuration(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={busy}>
          Schedule live class
        </Button>
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
    </div>
  );
}

function Attendance({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = React.useState(false);
  const [rows, setRows] = React.useState<Attendee[] | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    const r = await req("GET", `/live/${sessionId}/attendance`);
    if (r.ok) setRows(r.data as Attendee[]);
  }

  return (
    <>
      <Button size="sm" variant="ghost" className="h-7" onClick={toggle}>
        {open ? "Hide attendance" : "Attendance"}
      </Button>
      {open && (
        <div className="mt-1 w-full">
          {rows === null && <span className="text-muted-foreground">Loading…</span>}
          {rows && rows.length === 0 && <span className="text-muted-foreground">No one has joined yet.</span>}
          {rows && rows.length > 0 && (
            <ul className="ml-4 list-disc">
              {rows.map((a) => (
                <li key={a.studentId}>
                  {a.studentName} <span className="text-muted-foreground">· {when(a.joinedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Attach the recording of a class that has happened, or take it down early.
 *
 * Three steps, and the middle one is the browser talking straight to the
 * bucket: presign (what we will allow), PUT (the bytes, which the API never
 * sees), confirm (what actually arrived). Nothing is attached until the server
 * has looked at the bytes — an upload is a claim until then, and a failed PUT
 * that still said "Attached" is a defect this codebase has already met.
 */
function RecordingControl({ session, onChanged }: { session: Session; onChanged: () => void }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setErr(null);
    setBusy("Preparing…");
    const pre = await req("POST", `/live/${session.id}/recording/presign`, {
      fileName: file.name,
      contentType: file.type || "video/mp4",
      sizeBytes: file.size,
    });
    if (!pre.ok) {
      setBusy(null);
      setErr(pre.error);
      return;
    }
    const { url, key } = pre.data as { url: string; key: string };
    setBusy("Uploading…");
    // Straight to storage. A lecture is hundreds of megabytes and must never go
    // through the API — that is the whole point of a presigned PUT.
    const put = await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type || "video/mp4" } });
    if (!put.ok) {
      setBusy(null);
      setErr("The upload did not finish. Please try again.");
      return;
    }
    setBusy("Checking…");
    const done = await req("POST", `/live/${session.id}/recording/confirm`, { key });
    setBusy(null);
    if (!done.ok) {
      setErr(done.error);
      return;
    }
    onChanged();
  }

  async function remove() {
    setErr(null);
    setBusy("Removing…");
    const r = await req("DELETE", `/live/${session.id}/recording`);
    setBusy(null);
    if (!r.ok) setErr(r.error);
    else onChanged();
  }

  return (
    <>
      {/* Hidden, and still NAMED: a screen reader announces the control the
          click opens, and "blank" is what an unlabelled file input reads as. */}
      <input
        ref={fileRef}
        type="file"
        accept="video/mp4"
        aria-label={`Attach a recording of ${session.title}`}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
      {session.hasRecording ? (
        <>
          <span className="text-muted-foreground">· recorded</span>
          <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={!!busy} onClick={() => void remove()}>
            {busy ?? "Remove recording"}
          </Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="ghost" className="h-7" disabled={!!busy} onClick={() => fileRef.current?.click()}>
            {busy ?? "Attach recording"}
          </Button>
          {/* SAID BEFORE THE FILE IS CHOSEN, and derived from the same constant
              the server refuses on, so the screen cannot promise a size the API
              rejects. The teacher has already recorded by the time they get
              here, so the useful half of this is the RESOLUTION, not the
              number. */}
          {!busy && (
            <span className="text-muted-foreground">
              · MP4 up to {(MAX_RECORDING_BYTES / 1024 / 1024 / 1024).toFixed(1)} GB — record at 720p
            </span>
          )}
        </>
      )}
      {err && <span className="text-destructive">{err}</span>}
    </>
  );
}
