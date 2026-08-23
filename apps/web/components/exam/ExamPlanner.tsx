"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ExamScheduleDto, ExamSittingDto, ExamSeatDto, InvigilationDto, Serialized } from "@sms/types";
import { findHallClash, describeClash } from "@sms/types";
import { sendSms, postSms } from "@/components/game/play-ui";
import { personLabel } from "@/lib/people";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { shortDate } from "@/lib/format";

type Sitting = Serialized<ExamSittingDto>;
type Schedule = Serialized<ExamScheduleDto>;
type IdName = { id: string; name: string };

const input = "rounded-md border bg-background p-1.5 text-sm";

/**
 * The PLAN half of the exam console: a days x halls grid to see the shape of a
 * term at a glance, then a day-grouped list to work in.
 *
 * The list used to be one flat run of up to 200 sittings. A term is subjects x
 * class levels, so finding Tuesday's halls meant scrolling — which is why the grid
 * exists: it answers "what does this week look like, and where are the holes?"
 * without reading a single row.
 */
export function ExamPlanner({
  sittings,
  schedules,
  classes,
  staff,
  rooms,
  attachableExams,
  canRelease,
}: {
  sittings: Sitting[];
  schedules: Schedule[];
  classes: IdName[];
  staff: { id: string; name: string; roles?: string[] }[];
  rooms: IdName[];
  attachableExams: { id: string; title: string }[];
  canRelease: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [hallFilter, setHallFilter] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  /**
   * Seat a whole schedule and SAY WHAT HAPPENED.
   *
   * This used to announce "Seated every unseated sitting in this schedule." on
   * any success, without reading the response — and the response was counting
   * SITTINGS. A hall smaller than its class is filled to capacity and the rest
   * of the roll gets no seat, so a class of 30 in a hall of 5 reported one
   * sitting seated, nothing skipped, and five children with seats.
   */
  const seatAll = async (scheduleId: string) => {
    setBusy(true);
    setMsg(null);
    const res = await postSms<{
      seated: number;
      skipped: number;
      seatedStudents: number;
      unseatedStudents: number;
      overflow: Array<{ title: string; hall: string; capacity: number; classSize: number; unseated: number }>;
      skippedReasons: { alreadySeated: number; noClass: number; emptyClass: number };
    }>(`exams/schedules/${scheduleId}/seat`, {});
    setBusy(false);
    if (!res.ok || !res.data) {
      setMsg(res.error ?? "Failed.");
      return;
    }
    const d = res.data;
    const parts: string[] = [`Seated ${d.seatedStudents} candidate${d.seatedStudents === 1 ? "" : "s"} across ${d.seated} sitting${d.seated === 1 ? "" : "s"}.`];
    if (d.unseatedStudents > 0) {
      // The loud one: children with no seat.
      const halls = d.overflow.map((o) => `${o.title || o.hall} holds ${o.capacity} of ${o.classSize}`).join("; ");
      parts.push(`${d.unseatedStudents} candidate${d.unseatedStudents === 1 ? " has" : "s have"} NO seat — ${halls}. Open another hall or raise the capacity.`);
    }
    if (d.skippedReasons.noClass > 0) {
      parts.push(`${d.skippedReasons.noClass} sitting${d.skippedReasons.noClass === 1 ? " has" : "s have"} no class attached, so nobody can be seated in ${d.skippedReasons.noClass === 1 ? "it" : "them"}.`);
    }
    if (d.skippedReasons.emptyClass > 0) parts.push(`${d.skippedReasons.emptyClass} skipped: the class has no enrolled pupils.`);
    if (d.skippedReasons.alreadySeated > 0) parts.push(`${d.skippedReasons.alreadySeated} already seated (left untouched).`);
    setMsg(parts.join(" "));
    router.refresh();
  };

  const run = async (fn: () => Promise<{ ok: boolean; error?: string | null }>, ok: string) => {
    setBusy(true);
    setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) {
      setMsg(ok);
      router.refresh();
      return true;
    }
    setMsg(res.error ?? "Failed.");
    return false;
  };

  // Client-side narrowing of the already-loaded page. The SERVER filters by
  // schedule (see the page's ?schedule= param); these two are just fast local
  // whittling, so typing never costs a round trip.
  const visible = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sittings.filter((s) => {
      if (hallFilter && s.hall.trim().toLowerCase() !== hallFilter.trim().toLowerCase()) return false;
      if (!needle) return true;
      return `${s.title} ${s.subject ?? ""} ${s.className ?? ""}`.toLowerCase().includes(needle);
    });
  }, [sittings, q, hallFilter]);

  const halls = React.useMemo(
    () => [...new Set(sittings.map((s) => s.hall))].sort((a, b) => a.localeCompare(b)),
    [sittings],
  );

  // Days ascending for the grid — a planner reads forwards even though the list
  // below leads with the most recent.
  const days = React.useMemo(
    () => [...new Set(visible.map((s) => s.date))].sort((a, b) => a.localeCompare(b)),
    [visible],
  );

  // Clashes computed from the SAME pure rule the API enforces, so the grid can
  // never claim a schedule is clean that the server would reject.
  const clashes = React.useMemo(() => {
    const out = new Map<string, string>();
    const cands = sittings.map((s) => ({ id: s.id, date: s.date, startsAt: s.startsAt, endsAt: s.endsAt, hall: s.hall, title: s.title }));
    for (const s of cands) {
      const clash = findHallClash(s, cands.filter((o) => o.id !== s.id));
      if (clash) out.set(s.id, describeClash("hall", clash));
    }
    return out;
  }, [sittings]);

  const gridHalls = React.useMemo(
    () => [...new Set(visible.map((s) => s.hall))].sort((a, b) => a.localeCompare(b)).slice(0, 8),
    [visible],
  );

  return (
    <div className="space-y-6">
      {/* ---------------- schedules ---------------- */}
      <ScheduleBar schedules={schedules} busy={busy} run={run} seatAll={seatAll} />

      {/* ---------------- term grid ---------------- */}
      {days.length > 0 && gridHalls.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Term at a glance</CardTitle>
            <CardDescription>
              Every day against every hall. Empty cells are free slots; a red cell is a double-booking.
              {gridHalls.length === 8 ? " Showing the first 8 halls — filter by hall to see the rest." : ""}
            </CardDescription>
          </CardHeader>
          {/* Wide tables scroll in their OWN container so the page body never scrolls sideways. */}
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[640px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="sticky left-0 bg-card px-3 py-2 text-left font-medium">Day</th>
                  {gridHalls.map((h) => (
                    <th key={h} className="px-2 py-2 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day} className="border-b border-border last:border-0 align-top">
                    <th className="sticky left-0 whitespace-nowrap bg-card px-3 py-2 text-left font-medium">{shortDate(day)}</th>
                    {gridHalls.map((h) => {
                      const cell = visible.filter((s) => s.date === day && s.hall === h);
                      return (
                        <td key={h} className="px-2 py-2">
                          {cell.length === 0 ? (
                            <span className="text-muted-foreground/40">—</span>
                          ) : (
                            <div className="space-y-1">
                              {cell.map((s) => (
                                <button
                                  key={s.id}
                                  onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                                  className={`block w-full rounded px-1.5 py-1 text-left ${
                                    clashes.has(s.id) ? "bg-destructive/15 text-destructive" : "bg-primary/10"
                                  }`}
                                  title={clashes.get(s.id) ?? `${s.startsAt}–${s.endsAt}`}
                                >
                                  <span className="block truncate font-medium">{s.title}</span>
                                  <span className="block text-[11px] opacity-80">
                                    {s.startsAt} · {s.capacity > 0 ? `${s.seated}/${s.capacity}` : s.seated}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* ---------------- new sitting ---------------- */}
      <NewSittingForm
        schedules={schedules}
        classes={classes}
        rooms={rooms}
        attachableExams={attachableExams}
        busy={busy}
        run={run}
      />

      {/* ---------------- day-grouped list ---------------- */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <CardTitle className="text-base">Sittings</CardTitle>
              <CardDescription>Grouped by day — the way an exam officer works. Edit in place; seats and invigilators are kept.</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input placeholder="Search title, subject, class" className={`${input} w-52`} value={q} onChange={(e) => setQ(e.target.value)} />
              <select aria-label="Hall" className={input} value={hallFilter} onChange={(e) => setHallFilter(e.target.value)}>
                <option value="">All halls</option>
                {halls.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {visible.length === 0 && <p className="text-sm text-muted-foreground">No sittings match.</p>}
          {[...days].reverse().map((day) => (
            <div key={day} className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {shortDate(day)} · {visible.filter((s) => s.date === day).length} sitting(s)
              </p>
              {visible
                .filter((s) => s.date === day)
                .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
                .map((s) => (
                  <SittingRow
                    key={s.id}
                    s={s}
                    clash={clashes.get(s.id) ?? null}
                    editing={editing === s.id}
                    onEdit={() => setEditing(editing === s.id ? null : s.id)}
                    expanded={expanded === s.id}
                    onExpand={() => setExpanded(expanded === s.id ? null : s.id)}
                    classes={classes}
                    staff={staff}
                    rooms={rooms}
                    canRelease={canRelease}
                    busy={busy}
                    run={run}
                    onSaved={() => setEditing(null)}
                  />
                ))}
            </div>
          ))}
        </CardContent>
      </Card>

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ScheduleBar({
  schedules,
  busy,
  run,
  seatAll,
}: {
  schedules: Schedule[];
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string | null }>, ok: string) => Promise<boolean>;
  /** Reports the seating outcome rather than announcing a fixed success. */
  seatAll: (scheduleId: string) => Promise<void>;
}) {
  const [title, setTitle] = React.useState("");
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Exam schedules</CardTitle>
        <CardDescription>
          Group a term&apos;s sittings, seat them all in one go, then submit the whole schedule for head-teacher → principal approval.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <input placeholder="Schedule title (e.g. First Term Exams)" className={`${input} w-64`} value={title} onChange={(e) => setTitle(e.target.value)} />
          <Button size="sm" disabled={busy || !title} onClick={() => run(() => postSms("exams/schedules", { title }), "Schedule created.").then((ok) => ok && setTitle(""))}>
            New schedule
          </Button>
        </div>
        {schedules.map((sc) => (
          <div key={sc.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span>
              <span className="font-medium">{sc.title}</span>{" "}
              <span className="text-xs text-muted-foreground">{sc.sittingCount} sitting(s) · {sc.cbtCount} online</span>{" "}
              <Badge variant={sc.status === "APPROVED" ? "default" : sc.status === "PENDING_REVIEW" ? "secondary" : "outline"}>
                {sc.status.replace("_", " ").toLowerCase()}
              </Badge>
            </span>
            <span className="flex items-center gap-2">
              {/* Seat EVERY sitting in the schedule from its class roster, paper
                  included. Safe to press twice — already-seated sittings are
                  skipped, never renumbered. */}
              <Button
                size="sm"
                variant="outline"
                disabled={busy || sc.sittingCount === 0}
                onClick={() => void seatAll(sc.id)}
              >
                Seat all
              </Button>
              {sc.status === "DRAFT" && (
                <Button size="sm" variant="outline" disabled={busy || sc.sittingCount === 0} onClick={() => run(() => postSms(`exams/schedules/${sc.id}/submit`, {}), "Submitted for approval.")}>
                  Submit for approval
                </Button>
              )}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function NewSittingForm({
  schedules,
  classes,
  rooms,
  attachableExams,
  busy,
  run,
}: {
  schedules: Schedule[];
  classes: IdName[];
  rooms: IdName[];
  attachableExams: { id: string; title: string }[];
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string | null }>, ok: string) => Promise<boolean>;
}) {
  const [f, setF] = React.useState({
    title: "",
    subject: "",
    date: "",
    startsAt: "09:00",
    endsAt: "11:00",
    roomId: "",
    hall: "",
    capacity: "",
    classId: "",
    scheduleId: "",
    cbtExamId: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const venueOk = !!f.roomId || !!f.hall.trim();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Schedule a sitting</CardTitle>
        <CardDescription>
          Pick a room and its capacity comes with it. Setting the class lets this sitting be auto-seated later — including paper exams.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-2">
        <input placeholder="Title" className={`${input} w-40`} value={f.title} onChange={(e) => set("title", e.target.value)} />
        <input placeholder="Subject (optional)" className={`${input} w-36`} value={f.subject} onChange={(e) => set("subject", e.target.value)} />
        <input aria-label="Sitting date" type="date" className={input} value={f.date} onChange={(e) => set("date", e.target.value)} />
        <input aria-label="Sitting start time" type="time" className={input} value={f.startsAt} onChange={(e) => set("startsAt", e.target.value)} />
        <input aria-label="Sitting end time" type="time" className={input} value={f.endsAt} onChange={(e) => set("endsAt", e.target.value)} />
        <select aria-label="Room" className={input} value={f.roomId} onChange={(e) => set("roomId", e.target.value)}>
          <option value="">Room…</option>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        {/* Only offered when no room is picked — an ad-hoc venue is legitimate, but
            typing a hall that already exists in the registry is how duplicates start. */}
        {!f.roomId && (
          <input placeholder="…or type a hall" className={`${input} w-36`} value={f.hall} onChange={(e) => set("hall", e.target.value)} />
        )}
        <input type="number" min="0" placeholder="Seats" className={`${input} w-20`} value={f.capacity} onChange={(e) => set("capacity", e.target.value)} />
        <select aria-label="Class" className={input} value={f.classId} onChange={(e) => set("classId", e.target.value)}>
          <option value="">Class…</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select aria-label="Schedule" className={input} value={f.scheduleId} onChange={(e) => set("scheduleId", e.target.value)}>
          <option value="">No schedule</option>
          {schedules.filter((sc) => sc.status === "DRAFT").map((sc) => <option key={sc.id} value={sc.id}>{sc.title}</option>)}
        </select>
        <select aria-label="CBT exam" className={input} value={f.cbtExamId} onChange={(e) => set("cbtExamId", e.target.value)}>
          <option value="">Paper (no CBT)</option>
          {attachableExams.map((ex) => <option key={ex.id} value={ex.id}>{ex.title}</option>)}
        </select>
        <Button
          size="sm"
          disabled={busy || !f.title || !f.date || !venueOk}
          onClick={() =>
            run(
              () =>
                postSms("exams", {
                  title: f.title,
                  subject: f.subject || undefined,
                  date: f.date,
                  startsAt: f.startsAt,
                  endsAt: f.endsAt,
                  roomId: f.roomId || undefined,
                  hall: f.roomId ? undefined : f.hall,
                  capacity: f.capacity ? Number(f.capacity) : undefined,
                  classId: f.classId || undefined,
                  scheduleId: f.scheduleId || undefined,
                  cbtExamId: f.cbtExamId || undefined,
                }),
              "Sitting scheduled.",
            ).then((ok) => ok && setF({ ...f, title: "", subject: "", cbtExamId: "" }))
          }
        >
          Schedule
        </Button>
      </CardContent>
    </Card>
  );
}

function SittingRow({
  s,
  clash,
  editing,
  onEdit,
  expanded,
  onExpand,
  classes,
  staff,
  rooms,
  canRelease,
  busy,
  run,
  onSaved,
}: {
  s: Sitting;
  clash: string | null;
  editing: boolean;
  onEdit: () => void;
  expanded: boolean;
  onExpand: () => void;
  classes: IdName[];
  staff: { id: string; name: string; roles?: string[] }[];
  rooms: IdName[];
  canRelease: boolean;
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string | null }>, ok: string) => Promise<boolean>;
  onSaved: () => void;
}) {
  const [pick, setPick] = React.useState<{ classId?: string; staffId?: string }>({});
  const [seats, setSeats] = React.useState<Serialized<ExamSeatDto>[] | null>(null);
  const [roster, setRoster] = React.useState<Serialized<InvigilationDto>[] | null>(null);
  const [edit, setEdit] = React.useState({
    title: s.title,
    subject: s.subject ?? "",
    date: s.date,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    roomId: s.roomId ?? "",
    hall: s.hall,
    capacity: String(s.capacity || ""),
    classId: s.classId ?? "",
  });

  // Seat plan + roster load only when opened. They were already stored and already
  // had endpoints; nothing ever called them, so the artefact the whole seating
  // exercise produces could not be seen.
  React.useEffect(() => {
    if (!expanded) return;
    let live = true;
    (async () => {
      const [a, b] = await Promise.all([
        fetch(`/api/sms/exams/${s.id}/seats`).then((r) => (r.ok ? r.json() : [])),
        fetch(`/api/sms/exams/${s.id}/invigilators`).then((r) => (r.ok ? r.json() : [])),
      ]);
      if (!live) return;
      setSeats(a);
      setRoster(b);
    })();
    return () => {
      live = false;
    };
  }, [expanded, s.id]);

  const frozen = s.released;

  return (
    <div className={`rounded-md border p-3 ${clash ? "border-destructive/60" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {s.startsAt}–{s.endsAt} · {s.title}
            {s.subject ? <span className="text-muted-foreground"> · {s.subject}</span> : null}
            {s.className ? <span className="text-muted-foreground"> · {s.className}</span> : null}
          </p>
          <p className="text-sm text-muted-foreground">
            {s.hall}
            {s.capacity > 0 ? ` · ${s.seated}/${s.capacity} seated` : ` · ${s.seated} seated`} · {s.invigilators} invigilator(s)
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {clash && <Badge variant="destructive">{clash}</Badge>}
            {s.invigilators === 0 && <Badge variant="outline">no invigilator</Badge>}
            {s.seated === 0 && <Badge variant="outline">not seated</Badge>}
            {s.cbtExamId &&
              (s.released ? (
                <Badge variant="default">Released · {s.submitted}/{s.started} submitted</Badge>
              ) : (
                <Badge variant={s.cbtStatus === "PUBLISHED" ? "secondary" : "outline"}>
                  {(s.cbtStatus ?? "").replace("_", " ").toLowerCase() || "online"}
                </Badge>
              ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canRelease && s.cbtExamId && s.cbtStatus === "PUBLISHED" && !s.released && (
            <Button size="sm" disabled={busy} onClick={() => run(() => postSms(`exams/${s.id}/release`, {}), "Exam released — students can sit now.")}>
              Release
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onExpand}>
            {expanded ? "Hide" : "Seats & roster"}
          </Button>
          {/* A released exam is frozen: students may be mid-paper against a server
              clock derived from it, so re-timing is an incident, not an edit. */}
          <Button size="sm" variant="outline" disabled={frozen} title={frozen ? "Released — no longer editable" : undefined} onClick={onEdit}>
            {editing ? "Cancel" : "Edit"}
          </Button>
          <a className="text-xs text-muted-foreground underline hover:text-foreground" href={`/api/sms/exams/${s.id}/attendance.pdf`}>
            sheet
          </a>
          <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => run(() => sendSms("DELETE", `exams/${s.id}`), "Sitting removed.")}>
            remove
          </button>
        </div>
      </div>

      {editing && (
        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md bg-muted/40 p-2">
          <input aria-label="Sitting title" className={`${input} w-36`} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
          <input placeholder="Subject" className={`${input} w-32`} value={edit.subject} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
          <input aria-label="Sitting date" type="date" className={input} value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} />
          <input aria-label="Sitting start time" type="time" className={input} value={edit.startsAt} onChange={(e) => setEdit({ ...edit, startsAt: e.target.value })} />
          <input aria-label="Sitting end time" type="time" className={input} value={edit.endsAt} onChange={(e) => setEdit({ ...edit, endsAt: e.target.value })} />
          <select aria-label="Room" className={input} value={edit.roomId} onChange={(e) => setEdit({ ...edit, roomId: e.target.value })}>
            <option value="">Keep hall &quot;{s.hall}&quot;</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <input type="number" min="0" placeholder="Seats" className={`${input} w-20`} value={edit.capacity} onChange={(e) => setEdit({ ...edit, capacity: e.target.value })} />
          <select aria-label="Class" className={input} value={edit.classId} onChange={(e) => setEdit({ ...edit, classId: e.target.value })}>
            <option value="">No class</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  sendSms("PATCH", `exams/${s.id}`, {
                    title: edit.title,
                    subject: edit.subject || null,
                    date: edit.date,
                    startsAt: edit.startsAt,
                    endsAt: edit.endsAt,
                    ...(edit.roomId ? { roomId: edit.roomId } : {}),
                    ...(edit.capacity ? { capacity: Number(edit.capacity) } : {}),
                    classId: edit.classId || null,
                  }),
                "Saved — seating and invigilators kept.",
              ).then((ok) => ok && onSaved())
            }
          >
            Save
          </Button>
        </div>
      )}

      {expanded && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="rounded-md border p-2">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Seating plan</p>
            {seats === null ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : seats.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nobody seated yet.</p>
            ) : (
              <ol className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
                {seats.map((x) => (
                  <li key={x.studentId} className="flex justify-between gap-2">
                    <span className="truncate">{x.studentName}</span>
                    <span className="tabular-nums text-muted-foreground">#{x.seatNo}</span>
                  </li>
                ))}
              </ol>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select aria-label="Seat a class" className={`${input} text-xs`} value={pick.classId ?? ""} onChange={(e) => setPick({ ...pick, classId: e.target.value })}>
                <option value="">Seat a class…</option>
                {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <Button size="sm" variant="outline" disabled={busy || !pick.classId} onClick={() => run(() => postSms(`exams/${s.id}/seats`, { classId: pick.classId }), "Seating assigned.")}>
                Seat
              </Button>
            </div>
          </div>

          <div className="rounded-md border p-2">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Invigilators</p>
            {roster === null ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : roster.length === 0 ? (
              <p className="text-xs text-destructive">Nobody rostered.</p>
            ) : (
              <ul className="space-y-0.5 text-xs">
                {roster.map((r) => (
                  <li key={r.staffId} className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      {r.staffName}
                      {r.lead ? <span className="text-muted-foreground"> · lead</span> : null}
                    </span>
                    {/* The DELETE route existed and was unreachable, so a wrongly
                        assigned invigilator could not be taken off. */}
                    <button
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => run(() => sendSms("DELETE", `exams/${s.id}/invigilators/${r.staffId}`), "Invigilator removed.")}
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select aria-label="Add invigilator" className={`${input} text-xs`} value={pick.staffId ?? ""} onChange={(e) => setPick({ ...pick, staffId: e.target.value })}>
                <option value="">Add invigilator…</option>
                {staff.map((t) => <option key={t.id} value={t.id}>{personLabel(t)}</option>)}
              </select>
              <Button size="sm" variant="outline" disabled={busy || !pick.staffId} onClick={() => run(() => postSms(`exams/${s.id}/invigilators`, { staffId: pick.staffId }), "Invigilator assigned.")}>
                Assign
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
