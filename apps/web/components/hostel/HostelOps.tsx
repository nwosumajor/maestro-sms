"use client";

import type { HostelDto, HostelExeatDto, HostelIncidentDto, HostelAttendanceDto, HostelAllocationDto, Serialized } from "@sms/types";
import { StudentPicker } from "@/components/people/StudentPicker";
import * as React from "react";
import { useRegion } from "@/components/shell/RegionProvider";
import { todayIn } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";
import { shortDate } from "@/lib/format";

type Hostel = Serialized<HostelDto>;
type Alloc = Serialized<HostelAllocationDto>;
const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";
// The SCHOOL's day. This is both the DEFAULT and the `max` of the date input,
// so the UTC version did not merely prefill the wrong day — east of UTC it
// capped the input at YESTERDAY in the early morning, and today could not be
// recorded at all.
const today = (timezone: string) => todayIn(timezone);

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(`/api/sms${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, status: res.status, data: res.ok ? await res.json().catch(() => null) : null, error: res.ok ? null : await readApiError(res) };
}

/** Operational hostel tools: room transfer, nightly roll-call, exeat/gate-pass,
 *  and the maintenance/incident log. Warden/admin-only (hostel.manage). */
export function HostelOps({ hostels, allocations, students, canManage }: {
  hostels: Hostel[];
  allocations: Alloc[];
  students: { id: string; name: string }[];
  canManage: boolean;
}) {
  const [msg, setMsg] = React.useState<string | null>(null);
  if (!canManage) return null;
  const rooms = hostels.flatMap((h) => h.rooms.map((r) => ({ id: r.id, label: `${h.name} · ${r.roomNumber}` })));
  const boarders = allocations.filter((a) => a.status === "ACTIVE");

  return (
    <div className="space-y-4">
      {msg && <p className="rounded-md bg-muted px-3 py-2 text-sm">{msg}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <TransferPanel boarders={boarders} rooms={rooms} onMsg={setMsg} />
        <RollCallPanel hostels={hostels} onMsg={setMsg} />
        <ExeatPanel students={students} onMsg={setMsg} />
        <IncidentPanel hostels={hostels} onMsg={setMsg} />
      </div>
    </div>
  );
}

function TransferPanel({ boarders, rooms, onMsg }: { boarders: Alloc[]; rooms: { id: string; label: string }[]; onMsg: (s: string) => void }) {
  const [studentId, setStudentId] = React.useState(boarders[0]?.studentId ?? "");
  const [toRoomId, setToRoomId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const go = async () => {
    const r = await send("POST", "/hostels/allocations/transfer", { studentId, toRoomId, reason: reason || undefined });
    onMsg(r.ok ? "Student transferred to the new room." : (r.error ?? "Failed."));
  };
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Room transfer</CardTitle><CardDescription>Move a boarder to another room (vacate + re-allocate atomically).</CardDescription></CardHeader>
      <CardContent className="flex flex-wrap items-end gap-2">
        <div className="space-y-1"><Label>Student</Label>
          <select aria-label="Student" className={sel} value={studentId} onChange={(e) => setStudentId(e.target.value)}>
            {boarders.map((b) => <option key={b.id} value={b.studentId}>{b.studentName} ({b.roomNumber})</option>)}
          </select></div>
        <div className="space-y-1"><Label>To room</Label>
          <select aria-label="Move to room" className={sel} value={toRoomId} onChange={(e) => setToRoomId(e.target.value)}>
            <option value="">Select…</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select></div>
        <Input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} className="w-40" />
        <Button size="sm" disabled={!studentId || !toRoomId} onClick={go}>Transfer</Button>
      </CardContent>
    </Card>
  );
}

function RollCallPanel({ hostels, onMsg }: { hostels: Hostel[]; onMsg: (s: string) => void }) {
  const [hostelId, setHostelId] = React.useState(hostels[0]?.id ?? "");
  const { timezone } = useRegion();
  const [date, setDate] = React.useState(() => today(timezone));
  const [rows, setRows] = React.useState<Serialized<HostelAttendanceDto>[] | null>(null);
  const [boarders, setBoarders] = React.useState<{ studentId: string; studentName: string }[]>([]);
  const [marks, setMarks] = React.useState<Record<string, string>>({});

  const load = React.useCallback(async () => {
    if (!hostelId) return;
    const [att, alloc] = await Promise.all([
      fetch(`/api/sms/hostels/${hostelId}/attendance?date=${date}`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/sms/hostels/allocations?hostelId=${hostelId}`).then((r) => (r.ok ? r.json() : [])),
    ]);
    const existing = new Map((att as Serialized<HostelAttendanceDto>[]).map((a) => [a.studentId, a.status]));
    const bs = (alloc as Alloc[]).filter((a) => a.status === "ACTIVE").map((a) => ({ studentId: a.studentId, studentName: a.studentName }));
    setRows(att as Serialized<HostelAttendanceDto>[]);
    setBoarders(bs);
    setMarks(Object.fromEntries(bs.map((b) => [b.studentId, existing.get(b.studentId) ?? "PRESENT"])));
  }, [hostelId, date]);
  React.useEffect(() => { void load(); }, [load]);

  const save = async () => {
    const records = boarders.map((b) => ({ studentId: b.studentId, status: marks[b.studentId] ?? "PRESENT" }));
    const r = await send("POST", `/hostels/${hostelId}/attendance`, { date, records });
    onMsg(r.ok ? `Roll-call saved (${(r.data as { marked?: number })?.marked ?? 0} marked).` : (r.error ?? "Failed."));
    void load();
  };
  const STATUSES = ["PRESENT", "ABSENT", "EXEAT", "SICK", "LATE"];
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Nightly roll-call</CardTitle><CardDescription>Headcount of current boarders.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <select aria-label="Hostel" className={sel} value={hostelId} onChange={(e) => setHostelId(e.target.value)}>{hostels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
          <Input type="date" max={today(timezone)} value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
        </div>
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {boarders.length === 0 && <p className="text-sm text-muted-foreground">No active boarders.</p>}
          {boarders.map((b) => (
            <div key={b.studentId} className="flex items-center justify-between gap-2 text-sm">
              <span>{b.studentName}</span>
              <select aria-label="Attendance status" className="h-7 rounded border border-input bg-background px-2 text-xs" value={marks[b.studentId] ?? "PRESENT"} onChange={(e) => setMarks((m) => ({ ...m, [b.studentId]: e.target.value }))}>
                {STATUSES.map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()}</option>)}
              </select>
            </div>
          ))}
        </div>
        {boarders.length > 0 && <Button size="sm" onClick={save}>Save roll-call</Button>}
        {rows && rows.length > 0 && <p className="text-xs text-muted-foreground">Last saved: {rows.length} record(s).</p>}
      </CardContent>
    </Card>
  );
}

function ExeatPanel({ students, onMsg }: { students: { id: string; name: string }[]; onMsg: (s: string) => void }) {
  const [list, setList] = React.useState<Serialized<HostelExeatDto>[]>([]);
  const [studentId, setStudentId] = React.useState(students[0]?.id ?? "");
  const [reason, setReason] = React.useState("");
  const [depart, setDepart] = React.useState("");
  const [ret, setRet] = React.useState("");
  const load = React.useCallback(async () => {
    const r = await fetch("/api/sms/hostels/exeats");
    if (r.ok) setList(await r.json());
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  const request = async () => {
    const r = await send("POST", "/hostels/exeats", { studentId, reason, departAt: depart, expectedReturnAt: ret });
    onMsg(r.ok ? "Exeat requested — awaiting approval." : (r.error ?? "Failed."));
    if (r.ok) { setReason(""); void load(); }
  };
  const act = async (id: string, path: string, body?: unknown) => {
    const r = await send("POST", `/hostels/exeats/${id}/${path}`, body);
    onMsg(r.ok ? "Done." : (r.error ?? "Failed."));
    void load();
  };
  // The API computes `overdue` on every read, so this cannot be staler than the
  // list it came with.
  const overdue = list.filter((e) => e.overdue);
  const variant = (s: string) => (s === "APPROVED" || s === "RETURNED" ? "secondary" : s === "REJECTED" ? "destructive" : "outline");
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Exeat / gate-pass</CardTitle><CardDescription>Approved leave; guardians are notified on approval + movement.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        {/* LATE BACK, first and loudest. A boarder who has not returned is the
            thing this register exists to notice, and it used to be invisible:
            `expectedReturnAt` was recorded, shown to the parent once, and never
            read again. Anyone opening this page now sees it before anything
            else, and the hourly sweep tells the warden without them looking. */}
        {overdue.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">
              {overdue.length} boarder{overdue.length === 1 ? " is" : "s are"} late back
            </p>
            <ul className="mt-1 space-y-0.5 text-sm">
              {overdue.map((e) => (
                <li key={e.id}>
                  {e.studentName} — due back {new Date(e.expectedReturnAt).toLocaleString()}
                  {e.destination ? ` from ${e.destination}` : ""}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">
              Check on them, then record the return below.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          {/* Searched, not enumerated: the roster list is bounded, so a
    dropdown built from it would silently omit people. */}
<StudentPicker value={studentId} onChange={(id) => setStudentId(id)} seed={students} />
          <Input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} className="w-32" />
          <label className="text-xs text-muted-foreground">out<Input type="datetime-local" value={depart} onChange={(e) => setDepart(e.target.value)} className="h-9 w-44" /></label>
          <label className="text-xs text-muted-foreground">back<Input type="datetime-local" value={ret} onChange={(e) => setRet(e.target.value)} className="h-9 w-44" /></label>
          <Button size="sm" disabled={!reason || !depart || !ret} onClick={request}>Request</Button>
        </div>
        <div className="max-h-56 space-y-1 overflow-y-auto border-t border-border pt-2">
          {list.length === 0 && <p className="text-sm text-muted-foreground">No exeats.</p>}
          {list.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>{e.studentName} — {e.reason} <Badge variant={e.overdue ? "destructive" : variant(e.status)}>{e.overdue ? "late back" : e.status.toLowerCase()}</Badge></span>
              <span className="flex gap-1">
                {e.status === "REQUESTED" && <>
                  <Button size="sm" variant="outline" className="h-7" onClick={() => act(e.id, "decide", { approve: true })}>Approve</Button>
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => act(e.id, "decide", { approve: false })}>Reject</Button>
                </>}
                {e.status === "APPROVED" && <Button size="sm" variant="outline" className="h-7" onClick={() => act(e.id, "depart")}>Depart</Button>}
                {e.status === "DEPARTED" && <Button size="sm" variant="outline" className="h-7" onClick={() => act(e.id, "return")}>Return</Button>}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function IncidentPanel({ hostels, onMsg }: { hostels: Hostel[]; onMsg: (s: string) => void }) {
  const [list, setList] = React.useState<Serialized<HostelIncidentDto>[]>([]);
  const [hostelId, setHostelId] = React.useState(hostels[0]?.id ?? "");
  const [category, setCategory] = React.useState("MAINTENANCE");
  const [title, setTitle] = React.useState("");
  const load = React.useCallback(async () => {
    const r = await fetch("/api/sms/hostels/incidents");
    if (r.ok) setList(await r.json());
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  const report = async () => {
    const r = await send("POST", "/hostels/incidents", { hostelId, category, title });
    onMsg(r.ok ? "Incident logged." : (r.error ?? "Failed."));
    if (r.ok) { setTitle(""); void load(); }
  };
  const resolve = async (id: string) => {
    const r = await send("PUT", `/hostels/incidents/${id}`, { status: "RESOLVED" });
    onMsg(r.ok ? "Marked resolved." : (r.error ?? "Failed."));
    void load();
  };
  const CATS = ["MAINTENANCE", "DISCIPLINE", "HEALTH", "SECURITY", "OTHER"];
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Maintenance & incidents</CardTitle><CardDescription>Broken facilities, discipline, health, security.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <select aria-label="Hostel" className={sel} value={hostelId} onChange={(e) => setHostelId(e.target.value)}>{hostels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
          <select aria-label="Category" className={sel} value={category} onChange={(e) => setCategory(e.target.value)}>{CATS.map((c) => <option key={c} value={c}>{c[0] + c.slice(1).toLowerCase()}</option>)}</select>
          <Input placeholder="What happened?" value={title} onChange={(e) => setTitle(e.target.value)} className="w-48" />
          <Button size="sm" disabled={!title} onClick={report}>Log</Button>
        </div>
        <div className="max-h-56 space-y-1 overflow-y-auto border-t border-border pt-2">
          {list.length === 0 && <p className="text-sm text-muted-foreground">No incidents.</p>}
          {list.map((i) => (
            <div key={i.id} className="flex items-center justify-between gap-2 text-sm">
              <span>{i.hostelName} · {i.title} <Badge variant={i.status === "RESOLVED" ? "secondary" : "outline"}>{i.status.toLowerCase()}</Badge> <span className="text-xs text-muted-foreground">{shortDate(i.createdAt)}</span></span>
              {i.status !== "RESOLVED" && <Button size="sm" variant="ghost" className="h-7" onClick={() => resolve(i.id)}>Resolve</Button>}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
