"use client";

import type { IdNameDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readApiError } from "@/lib/api-error";
import { shortDate } from "@/lib/format";

const STATUSES = ["PRESENT", "ABSENT", "LATE", "EXCUSED"] as const;
type Status = (typeof STATUSES)[number];

type Student = Serialized<IdNameDto>;

/** The saved register for a class+date (records + who took it), or null. */
type Session = {
  id: string;
  date: string;
  takenBy?: { id: string; name: string } | null;
  updatedAt?: string;
  records: { studentId: string; status: Status; note?: string | null }[];
} | null;

/** A row in the "recent registers" browser. */
type SessionSummary = {
  id: string;
  date: string;
  takenBy?: { name: string } | null;
  _count?: { records: number };
};

const today = () => new Date().toISOString().slice(0, 10);

export function TakeRegister({ classes }: { classes: { id: string; name: string }[] }) {
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [date, setDate] = React.useState(today());
  const [roster, setRoster] = React.useState<Student[] | null>(null);
  const [marks, setMarks] = React.useState<Record<string, Status>>({});
  const [savedSession, setSavedSession] = React.useState<Session>(null);
  const [history, setHistory] = React.useState<SessionSummary[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  // Auto-load the roster AND any existing register whenever class/date changes —
  // no separate "Load roster" click. Existing marks (incl. gate scan check-ins)
  // are prefilled; only students with no record yet default to Present, so Save
  // EDITS the register instead of clobbering it.
  React.useEffect(() => {
    if (!classId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setMsg(null);
      setRoster(null);
      try {
        const [clsRes, regRes] = await Promise.all([
          fetch(`/api/sms/classes/${classId}`, { cache: "no-store" }),
          fetch(`/api/sms/classes/${classId}/attendance?date=${date}`, { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (!clsRes.ok) {
          setMsg("Could not load the roster.");
          setLoading(false);
          return;
        }
        const students = ((await clsRes.json()) as { students: Student[] }).students;
        const session = (regRes.ok ? await regRes.json() : null) as Session;
        const existing = new Map((session?.records ?? []).map((r) => [r.studentId, r.status]));
        setRoster(students);
        setSavedSession(session);
        setMarks(Object.fromEntries(students.map((s) => [s.id, existing.get(s.id) ?? ("PRESENT" as Status)])));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [classId, date]);

  // Recent registers for the selected class — a browsable history (past days,
  // including years ago). Clicking one jumps the date to view/edit it.
  React.useEffect(() => {
    if (!classId) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/sms/classes/${classId}/attendance`, { cache: "no-store" });
      if (cancelled || !res.ok) return;
      setHistory((await res.json()) as SessionSummary[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [classId, savedSession]);

  const setAll = (status: Status) => {
    if (!roster) return;
    setMarks(Object.fromEntries(roster.map((s) => [s.id, status])));
  };

  const tally = React.useMemo(() => {
    const t: Record<Status, number> = { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 };
    for (const st of Object.values(marks)) t[st] += 1;
    return t;
  }, [marks]);

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
    if (res.ok) {
      setSavedSession((await res.json()) as Session); // refresh "saved by / when"
      setMsg("Register saved. Guardians of absent/late students were notified.");
    } else {
      setMsg(await readApiError(res));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="att-class">Class</Label>
          <select
            id="att-class"
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="att-date">Date</Label>
          <Input
            id="att-date"
            type="date"
            value={date}
            max={today()}
            onChange={(e) => setDate(e.target.value)}
            className="w-44"
          />
        </div>
        {date !== today() && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setDate(today())}>
            Today
          </Button>
        )}
      </div>

      {/* Status of this register */}
      <p className="text-xs text-muted-foreground">
        {loading
          ? "Loading…"
          : savedSession
            ? `Saved${savedSession.takenBy ? ` by ${savedSession.takenBy.name}` : ""}. Editing updates it.`
            : "Not yet taken — everyone starts Present; mark the exceptions."}
      </p>

      {roster && roster.length > 0 && (
        <div className="space-y-3">
          {/* Live tally + bulk actions */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-emerald-100 px-2 py-1 font-medium text-emerald-800">{tally.PRESENT} present</span>
            <span className="rounded bg-red-100 px-2 py-1 font-medium text-red-800">{tally.ABSENT} absent</span>
            <span className="rounded bg-amber-100 px-2 py-1 font-medium text-amber-800">{tally.LATE} late</span>
            <span className="rounded bg-slate-100 px-2 py-1 font-medium text-slate-700">{tally.EXCUSED} excused</span>
            <span className="ml-auto flex gap-1">
              <Button type="button" variant="outline" size="sm" onClick={() => setAll("PRESENT")}>
                All present
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setAll("ABSENT")}>
                All absent
              </Button>
            </span>
          </div>

          <div className="space-y-2">
            {roster.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
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
          </div>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Saving…" : savedSession ? "Update register" : "Save register"}
          </Button>
        </div>
      )}

      {roster && roster.length === 0 && (
        <p className="text-sm text-muted-foreground">No students enrolled in this class.</p>
      )}
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      {/* Browsable history — any past day, including years ago. */}
      {history.length > 0 && (
        <div className="border-t border-border pt-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Past registers</p>
          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            {history.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => setDate(String(h.date).slice(0, 10))}
                title={`${h.takenBy?.name ? `Taken by ${h.takenBy.name}` : "Taken"}${
                  h._count ? ` · ${h._count.records} marked` : ""
                }`}
                className={
                  "rounded border px-2 py-1 text-xs transition-colors " +
                  (String(h.date).slice(0, 10) === date
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-accent")
                }
              >
                {shortDate(h.date)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
