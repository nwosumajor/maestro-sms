"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
interface Named { id: string; name: string }
interface Period extends Named { startTime: string; endTime: string }

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
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [teachers, setTeachers] = React.useState<Named[]>([]);
  const [entry, setEntry] = React.useState({ dayOfWeek: "MONDAY", periodId: periods[0]?.id ?? "", subject: "", teacherId: "", roomId: "" });

  const loadTeachers = React.useCallback(async (cid: string) => {
    if (!cid) return;
    const res = await fetch(`/api/sms/classes/${cid}`);
    if (!res.ok) { setTeachers([]); return; }
    const data = (await res.json()) as { teachers: Named[] };
    setTeachers(data.teachers);
    setEntry((s) => ({ ...s, teacherId: data.teachers[0]?.id ?? "" }));
  }, []);
  React.useEffect(() => { loadTeachers(classId); }, [classId, loadTeachers]);

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
    else setMsg(`Failed (${res.status}).`);
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

        <form onSubmit={addRoom} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5"><Label htmlFor="rm-name">Room</Label><Input id="rm-name" value={room.name} onChange={(e) => setRoom({ ...room, name: e.target.value })} placeholder="Room A" required /></div>
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
