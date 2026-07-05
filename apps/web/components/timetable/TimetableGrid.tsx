"use client";

// The weekly lesson grid. For read-only viewers it just shows subject/teacher/
// room per slot. For staff (canWrite) every FILLED cell gets inline Edit + Delete
// (fix a wrongly-entered lesson without re-creating it), and every EMPTY cell is
// clickable to add a lesson in that exact slot. All writes go through the
// conflict-checked API (a clash returns 409 with the reason).

import type { PeriodDto, TimetableEntryDto, IdNameDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
type Entry = Serialized<TimetableEntryDto>;
type Period = Serialized<PeriodDto>;
type Named = Serialized<IdNameDto>;
type Form = { subject: string; teacherId: string; roomId: string };

// MODULE-LEVEL (stable identity): defining this inside TimetableGrid would create
// a new component type on every keystroke, remounting it and making the subject
// input lose focus after each character — you could never type a lesson in.
function CellEditor({
  form, setForm, teachers, rooms, busy, onSave, onCancel,
}: {
  form: Form;
  setForm: React.Dispatch<React.SetStateAction<Form>>;
  teachers: Named[];
  rooms: Named[];
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const sel = "h-7 w-full rounded-md border border-input bg-background px-2 text-xs";
  return (
    <div className="mt-1.5 space-y-1.5 rounded-md border border-primary/40 bg-card p-2 shadow-card">
      <Input className="h-7 text-xs" placeholder="Subject" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
      <select className={sel} value={form.teacherId} onChange={(e) => setForm((f) => ({ ...f, teacherId: e.target.value }))}>
        {teachers.length === 0 && <option value="">No teacher on this class</option>}
        {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <select className={sel} value={form.roomId} onChange={(e) => setForm((f) => ({ ...f, roomId: e.target.value }))}>
        <option value="">No room</option>
        {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <div className="flex gap-1">
        <Button size="sm" className="h-6 flex-1 text-xs" disabled={busy} onClick={onSave}>Save</Button>
        <Button size="sm" variant="ghost" className="h-6 text-xs" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export function TimetableGrid({
  classId, entries, periods, rooms, teachers, canWrite,
}: {
  classId: string | undefined;
  entries: Entry[];
  periods: Period[];
  rooms: Named[];
  teachers: Named[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<string | null>(null); // entry id, or `new:${periodId}:${day}`
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<Form>({ subject: "", teacherId: "", roomId: "" });

  const cell = (periodId: string, day: string) => entries.find((e) => e.periodId === periodId && e.dayOfWeek === day);

  const openEdit = (e: Entry) => {
    setEditing(e.id);
    setForm({ subject: e.subject, teacherId: e.teacherId, roomId: e.roomId ?? "" });
    setMsg(null);
  };
  const openNew = (periodId: string, day: string) => {
    if (!canWrite || !classId) return;
    setEditing(`new:${periodId}:${day}`);
    setForm({ subject: "", teacherId: teachers[0]?.id ?? "", roomId: "" });
    setMsg(null);
  };

  const save = async (entry?: Entry, periodId?: string, day?: string) => {
    if (!form.subject.trim() || !form.teacherId) { setMsg("Subject and teacher are required."); return; }
    setBusy(true); setMsg(null);
    const body = { subject: form.subject.trim(), teacherId: form.teacherId, roomId: form.roomId || null };
    const res = entry
      ? await sendSms("PATCH", `timetable/entries/${entry.id}`, body)
      : await sendSms("POST", "timetable/entries", { classId, dayOfWeek: day, periodId, ...body });
    setBusy(false);
    if (res.ok) { setEditing(null); router.refresh(); }
    else setMsg(res.error ?? `Failed (${res.status}).`);
  };

  const del = async (e: Entry) => {
    if (!confirm(`Delete ${e.subject} from this slot?`)) return;
    setBusy(true); setMsg(null);
    const res = await sendSms("DELETE", `timetable/entries/${e.id}`);
    setBusy(false);
    if (res.ok) { setEditing(null); router.refresh(); }
    else setMsg(res.error ?? `Failed (${res.status}).`);
  };

  const editorProps = { form, setForm, teachers, rooms, busy, onCancel: () => setEditing(null) };

  return (
    <div className="space-y-2">
      {canWrite && teachers.length === 0 && (
        <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          This class has no teacher yet, so lessons can&apos;t be scheduled. Assign a class teacher or a
          subject teacher first (Classes → &ldquo;Subjects, teachers &amp; progression&rdquo;).
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border border-border/70 bg-card shadow-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-3 py-2.5 font-medium">Period</th>
              {DAYS.map((d) => <th key={d} className="px-3 py-2.5 font-medium capitalize">{d.toLowerCase()}</th>)}
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.id} className="border-b border-border last:border-0 align-top">
                <td className="whitespace-nowrap px-3 py-2.5">
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.startTime}–{p.endTime}</div>
                </td>
                {DAYS.map((d) => {
                  const e = cell(p.id, d);
                  const editKey = e ? e.id : `new:${p.id}:${d}`;
                  const isEditing = editing === editKey;
                  return (
                    <td key={d} className="px-2 py-2 align-top">
                      {e ? (
                        <div className="group rounded-md bg-primary/[0.06] px-2 py-1.5">
                          <div className="font-medium">{e.subject}</div>
                          <div className="text-xs text-muted-foreground">{e.teacherName}{e.room ? ` · ${e.room.name}` : ""}</div>
                          {canWrite && !isEditing && (
                            <div className="mt-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                              <button className="text-xs text-primary hover:underline" onClick={() => openEdit(e)}>Edit</button>
                              <button className="text-xs text-destructive hover:underline" disabled={busy} onClick={() => del(e)}>Delete</button>
                            </div>
                          )}
                          {isEditing && <CellEditor {...editorProps} onSave={() => save(e)} />}
                        </div>
                      ) : isEditing ? (
                        <CellEditor {...editorProps} onSave={() => save(undefined, p.id, d)} />
                      ) : canWrite ? (
                        <button className="grid h-8 w-full place-items-center rounded-md text-muted-foreground/40 transition-colors hover:bg-accent hover:text-foreground" onClick={() => openNew(p.id, d)} aria-label={`Add lesson ${p.name} ${d}`}>+</button>
                      ) : (
                        <span className="text-muted-foreground/40">·</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {periods.length === 0 && (
              <tr><td colSpan={DAYS.length + 1} className="px-3 py-4 text-muted-foreground">No periods defined yet — add periods above first.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}
