"use client";

import type {
  IdNameDto,
  PeriodDto,
  Serialized,
  TeacherUnavailabilityDto,
  TimetableGenerateResultDto,
} from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";
import { personLabel } from "@/lib/people";

const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
type Named = Serialized<IdNameDto> & { roles?: string[] };
type Period = Serialized<PeriodDto>;

export function TimetableAdmin({
  classes,
  periods,
  rooms,
  teachers: allTeachers,
}: {
  classes: Named[];
  periods: Period[];
  rooms: Named[];
  /** Teacher directory for the availability editor. */
  teachers: Named[];
}) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);

  // Generate the day structure from COUNT + BREAK POSITIONS (never typed
  // sequence numbers): N teaching periods, a start time, minutes per period, and
  // breaks at chosen positions. The server builds the ordered, time-consistent
  // period list.
  const [gen, setGen] = React.useState({ teachingPeriods: "8", dayStart: "08:00", periodMinutes: "40" });
  const [breaks, setBreaks] = React.useState<{ afterPeriod: string; minutes: string; name: string }[]>([]);
  const generateDay = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const res = await fetch("/api/sms/timetable/periods/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teachingPeriods: Number(gen.teachingPeriods),
        dayStart: gen.dayStart,
        periodMinutes: Number(gen.periodMinutes),
        breaks: breaks
          .filter((b) => b.afterPeriod && b.minutes)
          .map((b) => ({ afterPeriod: Number(b.afterPeriod), minutes: Number(b.minutes), name: b.name.trim() || undefined })),
      }),
    });
    if (res.ok) { setMsg("Day structure generated."); router.refresh(); }
    else setMsg(await readApiError(res));
  };

  // create room
  const [room, setRoom] = React.useState({ name: "", capacity: "" });
  const addRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/sms/timetable/rooms", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: room.name, capacity: room.capacity ? Number(room.capacity) : null }),
    });
    setMsg(res.ok ? "Room added." : `Room failed (${res.status}).`);
    if (res.ok) { setRoom({ name: "", capacity: "" }); router.refresh(); }
  };

  // add entry
  type Offering = { subjectId: string; subjectName: string; teacherId: string; teacherName: string };
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [teachers, setTeachers] = React.useState<Named[]>([]);
  const [offerings, setOfferings] = React.useState<Offering[]>([]);
  const [entry, setEntry] = React.useState({ dayOfWeek: "MONDAY", periodId: periods.find((p) => !p.isBreak)?.id ?? "", subjectId: "", teacherId: "", roomId: "" });

  const loadClassData = React.useCallback(async (cid: string) => {
    if (!cid) return;
    // Roster teachers (for the teacher select) + the class's subject offerings
    // (to auto-seed subject + assigned teacher).
    const [rosterRes, subjRes] = await Promise.all([
      fetch(`/api/sms/classes/${cid}`),
      fetch(`/api/sms/classes/${cid}/subjects`),
    ]);
    const roster = rosterRes.ok ? ((await rosterRes.json()) as { teachers: Named[] }).teachers : [];
    const subs = subjRes.ok ? ((await subjRes.json()) as Offering[]) : [];
    setOfferings(subs.map((s) => ({ subjectId: s.subjectId, subjectName: s.subjectName, teacherId: s.teacherId, teacherName: s.teacherName })));
    // Merge offering teachers into the option list so a picked offering's teacher exists.
    const merged = new Map<string, Named>();
    roster.forEach((t) => merged.set(t.id, t));
    subs.forEach((s) => merged.set(s.teacherId, { id: s.teacherId, name: s.teacherName }));
    setTeachers([...merged.values()]);
    setEntry((s) => ({ ...s, teacherId: roster[0]?.id ?? subs[0]?.teacherId ?? "" }));
  }, []);
  React.useEffect(() => { loadClassData(classId); }, [classId, loadClassData]);

  const addEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const res = await fetch("/api/sms/timetable/entries", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classId, dayOfWeek: entry.dayOfWeek, periodId: entry.periodId,
        subjectId: entry.subjectId, teacherId: entry.teacherId, roomId: entry.roomId || null,
      }),
    });
    if (res.ok) { setEntry((s) => ({ ...s, subjectId: "" })); setMsg("Lesson added."); router.refresh(); }
    else if (res.status === 409) setMsg("Conflict: that class, teacher, or room is already booked in this slot.");
    else setMsg(await readApiError(res));
  };

  const selCls = "h-9 rounded-md border border-input bg-background px-3 text-sm";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Manage timetable</CardTitle>
        <CardDescription>Define periods and rooms, then place conflict-checked lessons.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form onSubmit={generateDay} className="space-y-3 rounded-md border border-dashed border-border p-3">
          <p className="text-xs font-medium">Build the day — teaching periods &amp; break positions</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1"><Label className="text-xs">Teaching periods</Label><Input type="number" min={1} max={50} value={gen.teachingPeriods} onChange={(e) => setGen({ ...gen, teachingPeriods: e.target.value })} className="w-24" required /></div>
            <div className="space-y-1"><Label className="text-xs">Day starts</Label><Input type="time" value={gen.dayStart} onChange={(e) => setGen({ ...gen, dayStart: e.target.value })} className="w-32" required /></div>
            <div className="space-y-1"><Label className="text-xs">Minutes / period</Label><Input type="number" min={1} max={600} value={gen.periodMinutes} onChange={(e) => setGen({ ...gen, periodMinutes: e.target.value })} className="w-24" required /></div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label className="text-xs">Breaks</Label>
              <Button type="button" variant="outline" size="sm" className="h-7"
                onClick={() => setBreaks([...breaks, { afterPeriod: "", minutes: "20", name: "" }])}>+ Add break</Button>
            </div>
            {breaks.length === 0 && <p className="text-xs text-muted-foreground">No breaks — add one to place a break after a given period.</p>}
            {breaks.map((b, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <div className="space-y-1"><Label className="text-xs">After period</Label>
                  <select value={b.afterPeriod} onChange={(e) => setBreaks(breaks.map((x, j) => j === i ? { ...x, afterPeriod: e.target.value } : x))} className="h-9 w-28 rounded-md border border-input bg-background px-2 text-sm">
                    <option value="">—</option>
                    {Array.from({ length: Math.max(0, Number(gen.teachingPeriods) - 1) }, (_, k) => k + 1).map((n) => <option key={n} value={n}>Period {n}</option>)}
                  </select>
                </div>
                <div className="space-y-1"><Label className="text-xs">Minutes</Label><Input type="number" min={1} max={600} value={b.minutes} onChange={(e) => setBreaks(breaks.map((x, j) => j === i ? { ...x, minutes: e.target.value } : x))} className="w-20" /></div>
                <div className="space-y-1"><Label className="text-xs">Label</Label><Input value={b.name} onChange={(e) => setBreaks(breaks.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="Lunch" className="w-28" /></div>
                <Button type="button" variant="ghost" size="sm" className="h-9 text-destructive" onClick={() => setBreaks(breaks.filter((_, j) => j !== i))}>remove</Button>
              </div>
            ))}
          </div>
          <Button type="submit" variant="outline" size="sm">Generate day</Button>
          <p className="text-xs text-muted-foreground">Replaces the current periods. Clear placed lessons first if any exist.</p>
        </form>

        {periods.length > 0 && (
          <div className="space-y-1.5 border-t border-border pt-3">
            <p className="text-xs font-medium text-muted-foreground">Periods — edit name or time (order &amp; breaks come from the day builder above)</p>
            {[...periods].sort((a, b) => a.sequence - b.sequence).map((pd) => (
              <PeriodEditRow key={pd.id} period={pd} onSaved={() => router.refresh()} />
            ))}
          </div>
        )}

        <form onSubmit={addRoom} className="flex flex-wrap items-end gap-2">
          <div className="w-full">
            <p className="text-xs text-muted-foreground">
              A <strong>room</strong> is a physical teaching space (classroom, lab, hall). Assigning one to a
              lesson stops the same room being double-booked in a slot — it&apos;s optional; leave it as &ldquo;No
              room&rdquo; if you don&apos;t track rooms.
            </p>
          </div>
          <div className="space-y-1.5"><Label htmlFor="rm-name">Room</Label><Input id="rm-name" value={room.name} onChange={(e) => setRoom({ ...room, name: e.target.value })} placeholder="Room A / Physics Lab" required /></div>
          <div className="space-y-1.5"><Label htmlFor="rm-cap">Capacity</Label><Input id="rm-cap" type="number" min={1} value={room.capacity} onChange={(e) => setRoom({ ...room, capacity: e.target.value })} className="w-24" /></div>
          <Button type="submit" variant="outline" size="sm">Add room</Button>
        </form>

        {/* Rooms were addable but never shown, so a typo was invisible AND
            permanent — it stayed in every room picker with no way to reach it. */}
        {rooms.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {rooms.map((r) => (
              <RoomChip key={r.id} room={r} onRemoved={() => router.refresh()} />
            ))}
          </div>
        )}

        <form onSubmit={addEntry} className="space-y-3 border-t border-border pt-4">
          <Label>Add a lesson</Label>
          <div className="flex flex-wrap items-end gap-2">
            <select aria-label="Class" value={classId} onChange={(e) => setClassId(e.target.value)} className={selCls}>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select aria-label="Day" value={entry.dayOfWeek} onChange={(e) => setEntry({ ...entry, dayOfWeek: e.target.value })} className={selCls}>
              {DAYS.map((d) => <option key={d} value={d}>{d[0] + d.slice(1).toLowerCase()}</option>)}
            </select>
            <select aria-label="Period" value={entry.periodId} onChange={(e) => setEntry({ ...entry, periodId: e.target.value })} className={selCls}>
              {/* Break slots are not schedulable — only teaching periods appear. */}
              {periods.filter((p) => !p.isBreak).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.startTime})</option>)}
            </select>
            {/* The subject comes from the class's OFFERINGS (class-subject-teacher),
                never free text — the server requires a real subject id, so a lesson
                can no longer name a subject that isn't in the registry. Picking one
                also fills in that offering's assigned teacher. */}
            {offerings.length > 0 ? (
              <select
                aria-label="Subject"
                className={selCls}
                required
                value={entry.subjectId}
                onChange={(e) => {
                  const o = offerings.find((x) => x.subjectId === e.target.value);
                  setEntry((s) => ({ ...s, subjectId: e.target.value, teacherId: o ? o.teacherId : s.teacherId }));
                }}
              >
                <option value="">Subject…</option>
                {offerings.map((o) => (
                  <option key={o.subjectId} value={o.subjectId}>
                    {o.subjectName} — {o.teacherName}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-xs text-muted-foreground">
                Assign subjects to this class first — a lesson must name one of its offerings.
              </span>
            )}
            <select aria-label="Teacher" value={entry.teacherId} onChange={(e) => setEntry({ ...entry, teacherId: e.target.value })} className={selCls}>
              {teachers.length === 0 && <option value="">No class teacher</option>}
              {teachers.map((t) => <option key={t.id} value={t.id}>{personLabel(t)}</option>)}
            </select>
            <select aria-label="Room" value={entry.roomId} onChange={(e) => setEntry({ ...entry, roomId: e.target.value })} className={selCls}>
              <option value="">No room</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <Button type="submit" disabled={!entry.periodId || !entry.teacherId}>Add lesson</Button>
          </div>
        </form>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

        <TeacherAvailabilityEditor teachers={allTeachers} periods={periods} />
        <AutoGeneratePanel />
      </CardContent>
    </Card>
  );
}

/** Mark the (day, period) slots a teacher CANNOT teach — hard input to the CSP
 *  generator. Checked = unavailable; Save replaces the teacher's whole set. */
function TeacherAvailabilityEditor({ teachers, periods }: { teachers: Named[]; periods: Period[] }) {
  const [teacherId, setTeacherId] = React.useState(teachers[0]?.id ?? "");
  const [blocked, setBlocked] = React.useState<Set<string>>(new Set());
  // THREE states, not two. Saving REPLACES the teacher's whole set, so an empty
  // grid is an instruction to delete everything — and a failed load produced
  // exactly that grid, indistinguishable from "this teacher has no
  // restrictions". One click later their real availability was gone.
  const [load, setLoad] = React.useState<"loading" | "ready" | "failed">("loading");
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  const key = (day: string, periodId: string) => `${day}|${periodId}`;

  React.useEffect(() => {
    if (!teacherId) return;
    let cancelled = false;
    setLoad("loading");
    (async () => {
      const res = await fetch(`/api/sms/timetable/availability?teacherId=${teacherId}`).catch(() => null);
      if (cancelled) return;
      if (res?.ok) {
        const rows = (await res.json()) as Serialized<TeacherUnavailabilityDto>[];
        setBlocked(new Set(rows.map((r) => key(r.dayOfWeek, r.periodId))));
        setLoad("ready");
      } else {
        // Do NOT fall back to an empty set: that is a delete instruction
        // wearing the clothes of a clean slate.
        setBlocked(new Set());
        setLoad("failed");
      }
      setNote(null);
    })();
    return () => { cancelled = true; };
  }, [teacherId]);

  const toggle = (day: string, periodId: string) => {
    setBlocked((prev) => {
      const next = new Set(prev);
      const k = key(day, periodId);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const save = async () => {
    setBusy(true); setNote(null);
    const slots = [...blocked].map((k) => {
      const [dayOfWeek, periodId] = k.split("|");
      return { dayOfWeek, periodId };
    });
    const res = await fetch(`/api/sms/timetable/availability/${teacherId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slots }),
    });
    setBusy(false);
    setNote(res.ok ? "Availability saved ✓" : await readApiError(res));
  };

  if (teachers.length === 0 || periods.length === 0) return null;
  const ordered = [...periods].sort((a, b) => a.sequence - b.sequence);
  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <Label className="w-full">Teacher availability (for auto-generation)</Label>
      <p className="text-xs text-muted-foreground">
        Tick the slots this teacher <strong>cannot</strong> teach (part-time days, external
        commitments). The generator never schedules them there.
      </p>
      <select aria-label="Teacher" value={teacherId} onChange={(e) => setTeacherId(e.target.value)} className={sel}>
        {teachers.map((t) => <option key={t.id} value={t.id}>{personLabel(t)}</option>)}
      </select>
      <div className="overflow-x-auto">
        <table className="text-sm">
          <thead>
            <tr>
              <th className="pr-3 text-left font-medium text-muted-foreground">Period</th>
              {DAYS.map((d) => (
                <th key={d} className="px-2 text-left font-medium text-muted-foreground">{d[0] + d.slice(1, 3).toLowerCase()}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((p) => (
              <tr key={p.id}>
                <td className="pr-3 text-muted-foreground">{p.name} ({p.startTime})</td>
                {DAYS.map((d) => (
                  <td key={d} className="px-2 py-1 text-center">
                    <input
                      type="checkbox"
                      aria-label={`${p.name} ${d} unavailable`}
                      checked={blocked.has(key(d, p.id))}
                      onChange={() => toggle(d, p.id)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !teacherId || load !== "ready"}
          onClick={save}
        >
          {busy ? "Saving…" : "Save availability"}
        </Button>
        {load === "failed" && (
          <span className="text-xs text-destructive">
            Could not read this teacher&apos;s current availability, so saving is off — it would replace their whole
            set with what you can see. Reload and try again.
          </span>
        )}
        {load === "loading" && <span className="text-xs text-muted-foreground">Loading…</span>}
        {load === "ready" && !note && (
          <span className="text-xs text-muted-foreground">Saving replaces this teacher&apos;s whole set.</span>
        )}
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
    </div>
  );
}

/** Run the CSP generator and show its evidence: placed count, unplaced lessons
 *  with the blocking constraint, and over-allocation diagnostics. */
function AutoGeneratePanel() {
  const router = useRouter();
  const [replace, setReplace] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<Serialized<TimetableGenerateResultDto> | null>(null);

  const run = async () => {
    if (replace && !confirm("Replace ALL existing lessons for every class with subject offerings?")) return;
    setBusy(true); setError(null); setResult(null);
    const res = await fetch("/api/sms/timetable/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replace }),
    });
    setBusy(false);
    if (res.ok) {
      setResult((await res.json()) as Serialized<TimetableGenerateResultDto>);
      router.refresh();
    } else setError(await readApiError(res));
  };

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <Label className="w-full">Auto-generate the weekly grid (CSP solver)</Label>
      <p className="text-xs text-muted-foreground">
        Builds a conflict-free timetable from each class&apos;s subject offerings: the lessons-per-week
        set on each offering, teacher availability above, and each offering&apos;s fixed room are all
        respected. Review the generated grid below and hand-tweak any lesson as usual.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          Replace existing lessons first
        </label>
        <Button type="button" size="sm" disabled={busy} onClick={run}>
          {busy ? "Generating…" : "Generate timetable"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {result && (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm">
          <p>
            <strong>{result.placed}</strong> lesson{result.placed === 1 ? "" : "s"} placed
            {result.complete
              ? " — every quota satisfied."
              : " (best effort — see what couldn't fit below)."}
          </p>
          {result.diagnostics.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-amber-600 dark:text-amber-400">Impossible demand detected:</p>
              <ul className="list-disc pl-5 text-muted-foreground">
                {result.diagnostics.map((d, i) => (
                  <li key={i}>
                    {d.kind === "TEACHER_OVERLOAD" && <>Teacher <strong>{d.name}</strong> is over-allocated: {d.demand} lessons into {d.capacity} available slots.</>}
                    {d.kind === "CLASS_OVERLOAD" && <>Class <strong>{d.name}</strong> is over-quota: {d.demand} lessons into {d.capacity} free slots.</>}
                    {d.kind === "ROOM_OVERLOAD" && <>Room <strong>{d.name}</strong> is over-booked: {d.demand} lessons into {d.capacity} free slots.</>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.unplaced.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium">Could not place:</p>
              <ul className="list-disc pl-5 text-muted-foreground">
                {result.unplaced.map((u, i) => (
                  <li key={i}>{u.className} — {u.subject} ({u.teacherName}): {u.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One editable period row (name / sequence / start / end) → PATCH periods/:id. */
/** A room, with removal. The server owns the rule (lessons scheduled, or an
 *  offering preferring it) and names what blocks it. */
function RoomChip({ room, onRemoved }: { room: Named; onRemoved: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const remove = async () => {
    if (!confirm(`Remove ${room.name}?`)) return;
    setBusy(true); setErr(null);
    const res = await fetch(`/api/sms/timetable/rooms/${room.id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) onRemoved();
    else setErr(await readApiError(res));
  };

  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs">
        {room.name}
        <button type="button" onClick={remove} disabled={busy}
          title={`Remove ${room.name}`} className="text-muted-foreground hover:text-destructive">
          ×<span className="sr-only">Remove {room.name}</span>
        </button>
      </span>
      {err && <span className="max-w-56 text-[11px] text-destructive">{err}</span>}
    </span>
  );
}

function PeriodEditRow({ period, onSaved }: { period: Period; onSaved: () => void }) {
  const [name, setName] = React.useState(period.name);
  const [startTime, setStartTime] = React.useState(period.startTime);
  const [endTime, setEndTime] = React.useState(period.endTime);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);

  // Order is NOT edited here (it comes from the day builder) — only name + times.
  const dirty = name !== period.name || startTime !== period.startTime || endTime !== period.endTime;

  const save = async () => {
    setBusy(true); setNote(null);
    const res = await fetch(`/api/sms/timetable/periods/${period.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), startTime, endTime }),
    });
    setBusy(false);
    if (res.ok) { setNote("Saved ✓"); onSaved(); }
    else setNote(await readApiError(res));
  };

  // The server refuses while lessons sit in this period and says how many, so
  // the button stays enabled and the REASON is what the user sees. Disabling it
  // on a guess here would mean maintaining the same rule in two places.
  const remove = async () => {
    if (!confirm(`Remove ${period.name}? Lessons scheduled in it will block this.`)) return;
    setBusy(true); setNote(null);
    const res = await fetch(`/api/sms/timetable/periods/${period.id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) onSaved();
    else setNote(await readApiError(res));
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <span className="w-6 text-xs text-muted-foreground tabular-nums">{period.sequence}.</span>
      <div className="space-y-1"><Label className="text-xs">{period.isBreak ? "Break" : "Period"}</Label><Input value={name} onChange={(e) => setName(e.target.value)} className="w-28" /></div>
      <div className="space-y-1"><Label className="text-xs">Start</Label><Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-32" /></div>
      <div className="space-y-1"><Label className="text-xs">End</Label><Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="w-32" /></div>
      {period.isBreak && <span className="mb-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">break</span>}
      <Button type="button" variant="outline" size="sm" disabled={busy || !dirty || !name.trim()} onClick={save}>
        {busy ? "Saving…" : "Save"}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={remove}
        className="text-destructive hover:text-destructive">
        Remove
      </Button>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}
