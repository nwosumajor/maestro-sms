"use client";

import type { IdNameDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readApiError } from "@/lib/api-error";

import { useFormat } from "@/components/shell/RegionProvider";

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

/**
 * TODAY IS THE SCHOOL'S CALENDAR DAY, not the browser's UTC one.
 *
 * This used to be `new Date().toISOString().slice(0, 10)`, which is the UTC
 * date. For a school east of UTC that opens the register on YESTERDAY in the
 * early morning; for one west of UTC it opens TOMORROW in the evening — and the
 * teacher has no reason to look, because the field is prefilled and looks
 * right. The API already decides the term lock and the 7-day stale rule in the
 * school's zone, so the page was disagreeing with the server about what day it
 * is.
 *
 * en-CA formats as YYYY-MM-DD, which is what the date input wants. The zone
 * comes from the SESSION, so the server render and the client render agree —
 * deriving it from the runtime is a hydration mismatch.
 */
const todayIn = (timezone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());

export function TakeRegister({
  classes,
  lockBeforeDate,
  initialClassId,
}: {
  classes: { id: string; name: string }[];
  /** Dates before this (the current term's start) are read-only. */
  lockBeforeDate: string | null;
  /** Class to open on arrival, from the class board's Take-register link. Ignored
   *  when the caller cannot see it, so a bad link falls back rather than breaking. */
  initialClassId?: string;
}) {
  const [classId, setClassId] = React.useState(
    (initialClassId && classes.some((c) => c.id === initialClassId) ? initialClassId : classes[0]?.id) ?? "",
  );
  const { region, shortDate } = useFormat();
  // ONE value for "today", so the default, the max and the Today button cannot
  // disagree with each other or with the server.
  const schoolToday = React.useMemo(() => todayIn(region.timezone), [region.timezone]);
  const [date, setDate] = React.useState(schoolToday);
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

  const locked = Boolean(lockBeforeDate && date < lockBeforeDate);

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
      const data = (await res.json()) as Session | { pendingApproval: true };
      if (data && "pendingApproval" in data) {
        // A >7-day edit is not applied directly — it awaits a senior's approval.
        setMsg("This register is over 7 days old, so your change was submitted for approval by a head teacher, school admin or principal. It applies once approved (see Approvals).");
      } else {
        setSavedSession(data as Session); // refresh "saved by / when"
        setMsg("Register saved. Guardians of absent/late students were notified.");
      }
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
            max={schoolToday}
            onChange={(e) => setDate(e.target.value)}
            className="w-44"
          />
        </div>
        {date !== schoolToday && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setDate(schoolToday)}>
            Today
          </Button>
        )}
      </div>

      {/* Status of this register */}
      {locked ? (
        <p className="rounded-md bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700">
          🔒 Locked — this register is in a term that has ended. It is read-only.
          {savedSession?.takenBy ? ` Taken by ${savedSession.takenBy.name}.` : ""}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {loading
            ? "Loading…"
            : savedSession
              ? `Saved${savedSession.takenBy ? ` by ${savedSession.takenBy.name}` : ""}. Editing updates it.`
              : "Not yet taken — everyone starts Present; mark the exceptions."}
        </p>
      )}

      {roster && roster.length > 0 && (
        <div className="space-y-3">
          {/* Live tally + bulk actions */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-emerald-100 px-2 py-1 font-medium text-emerald-800">{tally.PRESENT} present</span>
            <span className="rounded bg-red-100 px-2 py-1 font-medium text-red-800">{tally.ABSENT} absent</span>
            <span className="rounded bg-amber-100 px-2 py-1 font-medium text-amber-800">{tally.LATE} late</span>
            <span className="rounded bg-slate-100 px-2 py-1 font-medium text-slate-700">{tally.EXCUSED} excused</span>
            {!locked && (
              <span className="ml-auto flex gap-1">
                <Button type="button" variant="outline" size="sm" onClick={() => setAll("PRESENT")}>
                  All present
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setAll("ABSENT")}>
                  All absent
                </Button>
              </span>
            )}
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
                      disabled={locked}
                      onClick={() => setMarks((m) => ({ ...m, [s.id]: st }))}
                      className={
                        "rounded px-2 py-1 text-xs font-medium transition-colors " +
                        (marks[s.id] === st
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:bg-accent") +
                        (locked ? " cursor-not-allowed opacity-60" : "")
                      }
                    >
                      {st[0] + st.slice(1).toLowerCase()}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {!locked && (
            <div className="space-y-1.5">
              {/* SAY IT BEFORE. Saving messages the guardians of everyone marked
                  absent or late, and a message cannot be unsent — correcting a
                  mis-tick afterwards does not recall it. The count is what makes
                  it checkable at a glance. */}
              {tally.ABSENT + tally.LATE > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-500">
                  Saving notifies the guardians of {tally.ABSENT + tally.LATE} pupil
                  {tally.ABSENT + tally.LATE === 1 ? "" : "s"} marked absent or late. It cannot be unsent.
                </p>
              )}
              <Button onClick={submit} disabled={busy}>
                {busy ? "Saving…" : savedSession ? "Update register" : "Save register"}
              </Button>
            </div>
          )}
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
