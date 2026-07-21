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

  // create period
  const [per, setPer] = React.useState({ name: "", sequence: String(periods.length + 1), startTime: "", endTime: "" });
  const addPeriod = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/sms/timetable/periods", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: per.name, sequence: Number(per.sequence), startTime: per.startTime, endTime: per.endTime }),
    });
    setMsg(res.ok ? "Period added." : `Period failed (${res.status}).`);
    if (res.ok) { setPer({ name: "", sequence: String(periods.length + 2), startTime: "", endTime: "" }); router.refresh(); }
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
  type Offering = { subjectName: string; teacherId: string; teacherName: string };
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [teachers, setTeachers] = React.useState<Named[]>([]);
  const [offerings, setOfferings] = React.useState<Offering[]>([]);
  const [entry, setEntry] = React.useState({ dayOfWeek: "MONDAY", periodId: periods[0]?.id ?? "", subject: "", teacherId: "", roomId: "" });

  const loadClassData = React.useCallback(async (cid: string) => {
    if (!cid) return;
    // Roster teachers (for the teacher select) + the class's subject offerings
    // (to auto-seed subject + assigned teacher).
    const [rosterRes, subjRes] = await Promise.all([
      fetch(`/api/sms/classes/${cid}`),
      fetch(`/api/sms/classes/${cid}/subjects`),
    ]);
    const roster = rosterRes.ok ? ((await rosterRes.json()) as { teachers: Named[] }).teachers : [];
    const subs = subjRes.ok ? ((await subjRes.json()) as { subjectName: string; teacherId: string; teacherName: string }[]) : [];
    setOfferings(subs.map((s) => ({ subjectName: s.subjectName, teacherId: s.teacherId, teacherName: s.teacherName })));
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
        subject: entry.subject, teacherId: entry.teacherId, roomId: entry.roomId || null,
      }),
    });
    if (res.ok) { setEntry((s) => ({ ...s, subject: "" })); setMsg("Lesson added."); router.refresh(); }
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
        <form onSubmit={addPeriod} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5"><Label htmlFor="pp-name">Period</Label><Input id="pp-name" value={per.name} onChange={(e) => setPer({ ...per, name: e.target.value })} placeholder="P1" className="w-24" required /></div>
          <div className="space-y-1.5"><Label htmlFor="pp-seq">Seq</Label><Input id="pp-seq" type="number" min={1} value={per.sequence} onChange={(e) => setPer({ ...per, sequence: e.target.value })} className="w-16" /></div>
          <div className="space-y-1.5"><Label htmlFor="pp-start">Start</Label><Input id="pp-start" type="time" value={per.startTime} onChange={(e) => setPer({ ...per, startTime: e.target.value })} className="w-32" required /></div>
          <div className="space-y-1.5"><Label htmlFor="pp-end">End</Label><Input id="pp-end" type="time" value={per.endTime} onChange={(e) => setPer({ ...per, endTime: e.target.value })} className="w-32" required /></div>
          <Button type="submit" variant="outline" size="sm">Add period</Button>
        </form>

        {periods.length > 0 && (
          <div className="space-y-1.5 border-t border-border pt-3">
            <p className="text-xs font-medium text-muted-foreground">Existing periods — edit name, time or order, then Save</p>
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
              {periods.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.startTime})</option>)}
            </select>
            {offerings.length > 0 && (
              <select
                aria-label="From class offerings"
                className={selCls}
                value=""
                onChange={(e) => {
                  const o = offerings[Number(e.target.value)];
                  if (o) setEntry((s) => ({ ...s, subject: o.subjectName, teacherId: o.teacherId }));
                }}
              >
                <option value="">From offerings…</option>
                {offerings.map((o, i) => <option key={i} value={i}>{o.subjectName} — {o.teacherName}</option>)}
              </select>
            )}
            <Input placeholder="Subject" value={entry.subject} onChange={(e) => setEntry({ ...entry, subject: e.target.value })} className="w-36" required />
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
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  const key = (day: string, periodId: string) => `${day}|${periodId}`;

  React.useEffect(() => {
    if (!teacherId) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/sms/timetable/availability?teacherId=${teacherId}`);
      if (cancelled) return;
      if (res.ok) {
        const rows = (await res.json()) as Serialized<TeacherUnavailabilityDto>[];
        setBlocked(new Set(rows.map((r) => key(r.dayOfWeek, r.periodId))));
      } else setBlocked(new Set());
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
        <Button type="button" size="sm" variant="outline" disabled={busy || !teacherId} onClick={save}>
          {busy ? "Saving…" : "Save availability"}
        </Button>
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
function PeriodEditRow({ period, onSaved }: { period: Period; onSaved: () => void }) {
  const [name, setName] = React.useState(period.name);
  const [sequence, setSequence] = React.useState(String(period.sequence));
  const [startTime, setStartTime] = React.useState(period.startTime);
  const [endTime, setEndTime] = React.useState(period.endTime);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);

  const dirty =
    name !== period.name ||
    Number(sequence) !== period.sequence ||
    startTime !== period.startTime ||
    endTime !== period.endTime;

  const save = async () => {
    setBusy(true); setNote(null);
    const res = await fetch(`/api/sms/timetable/periods/${period.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), sequence: Number(sequence), startTime, endTime }),
    });
    setBusy(false);
    if (res.ok) { setNote("Saved ✓"); onSaved(); }
    else setNote(await readApiError(res));
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1"><Label className="text-xs">Period</Label><Input value={name} onChange={(e) => setName(e.target.value)} className="w-24" /></div>
      <div className="space-y-1"><Label className="text-xs">Seq</Label><Input type="number" min={1} value={sequence} onChange={(e) => setSequence(e.target.value)} className="w-16" /></div>
      <div className="space-y-1"><Label className="text-xs">Start</Label><Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-32" /></div>
      <div className="space-y-1"><Label className="text-xs">End</Label><Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="w-32" /></div>
      <Button type="button" variant="outline" size="sm" disabled={busy || !dirty || !name.trim()} onClick={save}>
        {busy ? "Saving…" : "Save"}
      </Button>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}
