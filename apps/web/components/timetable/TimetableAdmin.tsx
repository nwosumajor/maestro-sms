"use client";

import type { IdNameDto, PeriodDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
type Named = Serialized<IdNameDto>;
type Period = Serialized<PeriodDto>;

export function TimetableAdmin({
  classes,
  periods,
  rooms,
}: {
  classes: Named[];
  periods: Period[];
  rooms: Named[];
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
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select aria-label="Room" value={entry.roomId} onChange={(e) => setEntry({ ...entry, roomId: e.target.value })} className={selCls}>
              <option value="">No room</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <Button type="submit" disabled={!entry.periodId || !entry.teacherId}>Add lesson</Button>
          </div>
        </form>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
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
