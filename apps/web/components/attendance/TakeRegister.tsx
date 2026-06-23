"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const STATUSES = ["PRESENT", "ABSENT", "LATE", "EXCUSED"] as const;
type Status = (typeof STATUSES)[number];

interface Student { id: string; name: string }

export function TakeRegister({ classes }: { classes: { id: string; name: string }[] }) {
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [date, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [roster, setRoster] = React.useState<Student[] | null>(null);
  const [marks, setMarks] = React.useState<Record<string, Status>>({});
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const loadRoster = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/sms/classes/${classId}`);
    setBusy(false);
    if (!res.ok) {
      setMsg("Could not load the roster.");
      return;
    }
    const data = (await res.json()) as { students: Student[] };
    setRoster(data.students);
    setMarks(Object.fromEntries(data.students.map((s) => [s.id, "PRESENT" as Status])));
  };

  const submit = async () => {
    if (!roster) return;
    setBusy(true);
    setMsg(null);
    const records = roster.map((s) => ({ studentId: s.id, status: marks[s.id] ?? "PRESENT" }));
    const res = await fetch(`/api/sms/classes/${classId}/attendance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, records }),
    });
    setBusy(false);
    setMsg(res.ok ? "Register saved. Guardians of absent/late students were notified." : `Failed (${res.status}).`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="att-class">Class</Label>
          <select
            id="att-class"
            value={classId}
            onChange={(e) => { setClassId(e.target.value); setRoster(null); }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="att-date">Date</Label>
          <Input id="att-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
        </div>
        <Button variant="outline" onClick={loadRoster} disabled={busy || !classId}>
          Load roster
        </Button>
      </div>

      {roster && roster.length > 0 && (
        <div className="space-y-2">
          {roster.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <span className="text-sm font-medium">{s.name}</span>
              <div className="flex gap-1">
                {STATUSES.map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setMarks((m) => ({ ...m, [s.id]: st }))}
                    className={
                      "rounded px-2 py-1 text-xs font-medium transition-colors " +
                      (marks[s.id] === st
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-accent")
                    }
                  >
                    {st[0] + st.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save register"}</Button>
        </div>
      )}

      {roster && roster.length === 0 && (
        <p className="text-sm text-muted-foreground">No students enrolled in this class.</p>
      )}
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}
