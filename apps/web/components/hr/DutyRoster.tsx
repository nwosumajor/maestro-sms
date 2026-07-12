"use client";

// =============================================================================
// DutyRoster — assign + view dated duties for non-timetabled staff (client)
// =============================================================================
// hr.write assigns (multi-staff × multi-date in one call; assignees get a
// notification); hr.read views the range. Unassign deletes (a roster is a plan).
// =============================================================================

import type { DutyAssignmentDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Duty = Serialized<DutyAssignmentDto>;
type StaffOption = { userId: string; userName: string };

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
  const error = j?.message ? (Array.isArray(j.message) ? j.message.join(", ") : j.message) : `Failed (${res.status}).`;
  return { ok: false as const, error };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function DutyRoster({ staff, canWrite }: { staff: StaffOption[]; canWrite: boolean }) {
  const today = new Date();
  const weekAhead = new Date(today.getTime() + 13 * 24 * 3600 * 1000);
  const [duties, setDuties] = React.useState<Duty[] | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [dates, setDates] = React.useState<string>(iso(today));
  const [title, setTitle] = React.useState("");
  const [start, setStart] = React.useState("08:00");
  const [end, setEnd] = React.useState("16:00");
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const r = await req("GET", `/hr/duty?from=${iso(today)}&to=${iso(weekAhead)}`);
    if (r.ok) setDuties(r.data as Duty[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function assign() {
    const dateList = dates.split(",").map((s) => s.trim()).filter(Boolean);
    if (!title.trim() || selected.length === 0 || dateList.length === 0) return;
    setBusy(true);
    setErr(null);
    const r = await req("POST", `/hr/duty`, {
      userIds: selected,
      dates: dateList,
      title: title.trim(),
      startTime: start,
      endTime: end,
    });
    setBusy(false);
    if (r.ok) {
      setTitle("");
      setSelected([]);
      void load();
    } else setErr(r.error);
  }

  async function unassign(id: string) {
    const r = await req("DELETE", `/hr/duty/${id}`);
    if (r.ok) void load();
    else setErr(r.error);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Duty roster (next 2 weeks)</CardTitle>
        <CardDescription>
          Gate duty, night watch, weekend supervision — shifts for staff the teaching timetable doesn’t
          cover. Assignees are notified.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canWrite && (
          <div className="space-y-2 rounded-md border border-dashed p-3">
            <div className="flex flex-wrap gap-1">
              {staff.map((s) => (
                <button
                  key={s.userId}
                  type="button"
                  onClick={() =>
                    setSelected((cur) => (cur.includes(s.userId) ? cur.filter((x) => x !== s.userId) : [...cur, s.userId]))
                  }
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${
                    selected.includes(s.userId) ? "border-primary bg-primary text-primary-foreground" : "bg-background"
                  }`}
                >
                  {s.userName}
                </button>
              ))}
              {staff.length === 0 && <span className="text-xs text-muted-foreground">No active staff records.</span>}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Duty</Label>
                <Input className="w-44" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Night watch" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Dates (comma-sep)</Label>
                <Input className="w-56" value={dates} onChange={(e) => setDates(e.target.value)} placeholder="2026-07-18, 2026-07-19" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">From</Label>
                <Input className="w-20" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">To</Label>
                <Input className="w-20" value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>
              <Button size="sm" onClick={assign} disabled={busy || selected.length === 0 || !title.trim()}>
                Assign duty
              </Button>
            </div>
          </div>
        )}

        {duties === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : duties.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing rostered for the next two weeks.</p>
        ) : (
          <ul className="space-y-1">
            {duties.map((d) => (
              <li key={d.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                <span className="w-24 text-muted-foreground">
                  {new Date(d.date).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
                </span>
                <span className="font-medium">{d.userName ?? "Staff"}</span>
                <span>{d.title}</span>
                <span className="text-xs text-muted-foreground">
                  {d.startTime}–{d.endTime}
                </span>
                {canWrite && (
                  <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-destructive" onClick={() => unassign(d.id)}>
                    ✕
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}

/** Staff self-service: my upcoming duties (rendered on /leave). */
export function MyDuties({ initial }: { initial: Duty[] }) {
  if (initial.length === 0) return null; // nothing rostered — keep /leave uncluttered
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">My duties</CardTitle>
        <CardDescription>Your upcoming rostered shifts.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 text-sm">
          {initial.map((d) => (
            <li key={d.id} className="flex items-center gap-2">
              <span className="w-28 text-muted-foreground">
                {new Date(d.date).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
              </span>
              <span className="font-medium">{d.title}</span>
              <span className="text-xs text-muted-foreground">
                {d.startTime}–{d.endTime}
                {d.note ? ` · ${d.note}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
