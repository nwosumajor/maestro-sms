"use client";

// =============================================================================
// LiveSessions — scheduled live/virtual classes for a class (client island)
// =============================================================================
// Everyone on the class page sees the schedule; the "Join" button asks the API
// for the URL (which records attendance + gates the join window server-side).
// Staff/host additionally get a create form, status controls, and the attendance
// register. The API is authoritative for scope, the join window, and URL safety.
// =============================================================================

import Link from "next/link";
import type {
  LmsClassLiveSessionsDto,
  LmsLiveAttendanceDto,
  LmsLiveSessionDto,
  Serialized,
} from "@sms/types";
import { interpretApiError } from "@/lib/api-error";
import * as React from "react";
import { RecordingControl } from "@/components/lms/RecordingControl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Session = Serialized<LmsLiveSessionDto>;
type Attendee = Serialized<LmsLiveAttendanceDto>;
type Panel = Serialized<LmsClassLiveSessionsDto>;

/**
 * One subject the class runs, and who teaches it.
 *
 * The page already reads these for the scheme-of-work panels; the picker below
 * reuses them rather than asking again.
 */
export type Offering = { subjectId: string; subjectName: string; teacherId: string };

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

export function LiveSessions({
  classId,
  canManage,
  offerings = [],
  userId,
  canUseAnySubject = false,
}: {
  classId: string;
  canManage: boolean;
  /** The class's subjects, for the picker. */
  offerings?: Offering[];
  /** The viewer, to work out which of those subjects are theirs. */
  userId?: string;
  /** School-wide staff may file a session under any of the class's subjects;
   *  a teacher may use only their own. The server decides either way. */
  canUseAnySubject?: boolean;
}) {
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [total, setTotal] = React.useState(0);
  const [narrowed, setNarrowed] = React.useState<boolean | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  const load = React.useCallback(async () => {
    const r = await req("GET", `/classes/${classId}/live`);
    if (r.ok) {
      const panel = r.data as Panel;
      setSessions(panel.rows);
      setTotal(panel.total);
      setNarrowed(panel.narrowedToMySubjects);
    } else setErr(r.error);
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
        {canManage && (
          <CreateForm
            classId={classId}
            onCreated={load}
            subjects={canUseAnySubject ? offerings : offerings.filter((o) => o.teacherId === userId)}
            canUseAnySubject={canUseAnySubject}
          />
        )}

        {/* A FAIL-OPEN NOBODY IS TOLD ABOUT IS A SILENT ONE. This list narrows
            to the subjects the pupil offers; when no selection has been
            approved it narrows to nothing, and without this line "you take
            every subject here" and "nobody has approved your choices" look
            exactly the same on screen. */}
        {narrowed === false && (
          <p className="text-sm text-muted-foreground">
            Showing every subject this class runs. Your subject choices for this term haven&rsquo;t been
            approved yet — once they are, you&rsquo;ll only see the lessons for the subjects you take.
          </p>
        )}

        {loaded && sessions.length === 0 && <p className="text-sm text-muted-foreground">No live classes scheduled.</p>}

        {sessions.map((s) => (
          <div key={s.id} className="rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.title}</span>
              {/* WHICH SUBJECT. The whole rule above is about subjects, and a
                  row that does not name one leaves the reader unable to see it
                  working — or to spot a lesson filed under the wrong one. */}
              {s.subjectName && <Badge variant="secondary">{s.subjectName}</Badge>}
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
                <RecordingControl
                  sessionId={s.id}
                  title={s.title}
                  hasRecording={s.hasRecording}
                  onChanged={load}
                />
              </div>
            )}
          </div>
        ))}
        {/* A CAP WITH NO COUNT READS AS THE WHOLE RECORD. The panel holds the
            most recent slice; the diary pages, searches and date-filters the
            same sessions, so the rest is one link away rather than lost. */}
        {total > sessions.length && (
          <p className="text-sm text-muted-foreground">
            Showing the {sessions.length} most recent of {total}.{" "}
            <Link href={`/live-classes?classId=${classId}`} className="underline underline-offset-4">
              See all live classes
            </Link>
            .
          </p>
        )}

        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * Scheduling a live class.
 *
 * THE SUBJECT FIELD IS WHY THIS EXISTS. The API has taken `subjectId` since the
 * table was created, and this form never sent one — so every live class booked
 * through the product was UNTAGGED, and the rule that shows a pupil only the
 * lessons for subjects they offer passed all of them through to the whole
 * class. The server-side half was correct and inert: a field no screen can fill
 * in is a feature nobody has.
 *
 * The list offers the caller's OWN subjects, because those are the ones the
 * server will accept — a teacher of Maths cannot file a session under Physics,
 * and rendering the option anyway produces a form that fails on Save rather
 * than a control that is absent. School-wide staff get the whole list.
 */
function CreateForm({
  classId,
  onCreated,
  subjects,
  canUseAnySubject,
}: {
  classId: string;
  onCreated: () => void;
  subjects: Offering[];
  canUseAnySubject: boolean;
}) {
  const [title, setTitle] = React.useState("");
  const [provider, setProvider] = React.useState("MEET");
  const [joinUrl, setJoinUrl] = React.useState("");
  const [startsAt, setStartsAt] = React.useState("");
  const [duration, setDuration] = React.useState("60");
  const [subjectId, setSubjectId] = React.useState("");
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
      // Omitted, not null, when no subject is chosen: an untagged session is a
      // whole-class one (a form period, an assembly) and reaches everybody.
      ...(subjectId ? { subjectId } : {}),
    });
    setBusy(false);
    if (r.ok) {
      setTitle("");
      setJoinUrl("");
      setStartsAt("");
      setSubjectId("");
      onCreated();
    } else setErr(r.error);
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      {/* Every field is NAMED — `htmlFor` to an `id`, not a label floating
          beside an input. Three of these were unlabelled, so a screen reader
          announced them as blank and no test could reach them by name either. */}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="live-title">Title</Label>
          <Input id="live-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Algebra revision" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="live-provider">Provider</Label>
          <select id="live-provider" className={sel + " w-full"} value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="MEET">Google Meet</option>
            <option value="ZOOM">Zoom</option>
            <option value="JITSI">Jitsi</option>
            <option value="OTHER">Other (https)</option>
          </select>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs" htmlFor="live-join-url">Join link (https)</Label>
          <Input id="live-join-url" value={joinUrl} onChange={(e) => setJoinUrl(e.target.value)} placeholder="https://meet.google.com/…" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="live-starts">Starts</Label>
          <Input id="live-starts" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="live-duration">Duration (min)</Label>
          <Input id="live-duration" type="number" min={1} value={duration} onChange={(e) => setDuration(e.target.value)} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs" htmlFor="live-subject">
            Subject
          </Label>
          <select
            id="live-subject"
            className={sel + " w-full"}
            value={subjectId}
            onChange={(e) => setSubjectId(e.target.value)}
          >
            <option value="">No subject — the whole class</option>
            {subjects.map((o) => (
              <option key={o.subjectId} value={o.subjectId}>
                {o.subjectName}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {subjects.length === 0
              ? "You don't teach a subject in this class, so this session is for the whole class."
              : canUseAnySubject
                ? "Pupils who take the subject see the lesson. Leave it unset for an assembly or form period, which reaches everyone."
                : "Only the subjects you teach here. Pupils who take the subject see the lesson; leave it unset for a whole-class session."}
          </p>
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
