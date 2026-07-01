"use client";

// Hostel Management UI. Wardens / admins create hostels + rooms (with rent and
// custom fields), allocate students, see one-click bed availability, and schedule
// hostel fees (which post as invoice line items alongside academic fees).

import type { HostelDto, HostelAllocationDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";

type Hostel = Serialized<HostelDto>;
type Allocation = Serialized<HostelAllocationDto>;
type Student = { id: string; name: string };

export function HostelManager({
  hostels,
  allocations,
  students,
  staff = [],
  canManage,
  canCreate = canManage,
}: {
  hostels: Hostel[];
  allocations: Allocation[];
  students: Student[];
  staff?: Student[];
  canManage: boolean;
  /** Creating a hostel is admin-only; a warden manages their existing hostel. */
  canCreate?: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // new hostel
  const [hName, setHName] = React.useState("");
  const [hType, setHType] = React.useState("MIXED");
  const [hWarden, setHWarden] = React.useState("");
  // new room (per hostel)
  const [roomFor, setRoomFor] = React.useState("");
  const [rNum, setRNum] = React.useState("");
  const [rCap, setRCap] = React.useState(2);
  const [rRent, setRRent] = React.useState(0);
  // allocate
  const [allocRoom, setAllocRoom] = React.useState("");
  const [allocStudent, setAllocStudent] = React.useState(students[0]?.id ?? "");
  // schedule fees
  const [feeHostel, setFeeHostel] = React.useState("");
  const [feeDue, setFeeDue] = React.useState("");

  const run = async (fn: () => Promise<{ ok: boolean; status: number; error: string | null }>, ok: string) => {
    setBusy(true);
    setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) {
      setMsg(ok);
      router.refresh();
    } else {
      setMsg(res.error ?? `Failed (${res.status}).`);
    }
  };

  const allRooms = hostels.flatMap((h) => h.rooms.map((r) => ({ ...r, hostelName: h.name })));

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      {canCreate && (
        <Card>
          <CardHeader><CardTitle className="text-base">Create hostel</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5"><Label htmlFor="h-name">Name</Label><Input id="h-name" value={hName} onChange={(e) => setHName(e.target.value)} placeholder="Unity House" /></div>
            <div className="space-y-1.5">
              <Label htmlFor="h-type">Type</Label>
              <select id="h-type" value={hType} onChange={(e) => setHType(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option>MIXED</option><option>BOYS</option><option>GIRLS</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="h-warden">Warden</Label>
              <select id="h-warden" value={hWarden} onChange={(e) => setHWarden(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">— none —</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <Button disabled={busy || !hName} onClick={() => run(() => postSms("hostels", { name: hName, type: hType, wardenId: hWarden || null }), "Hostel created.")}>Create</Button>
          </CardContent>
        </Card>
      )}

      {hostels.map((h) => (
        <Card key={h.id}>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              {h.name} <Badge variant="secondary">{h.type}</Badge>
              {h.wardenName && <span className="text-xs font-normal text-muted-foreground">Warden: {h.wardenName}</span>}
            </CardTitle>
            <CardDescription>
              {/* One-click availability */}
              Beds: {h.availableBeds} available / {h.totalBeds} total ({h.occupiedBeds} occupied)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {h.rooms.length > 0 && (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Room</th><th className="py-1 pr-3 font-medium">Type</th>
                  <th className="py-1 pr-3 font-medium">Rent</th><th className="py-1 pr-3 font-medium">Occupied</th>
                  <th className="py-1 font-medium">Available</th>
                </tr></thead>
                <tbody>
                  {h.rooms.map((r) => (
                    <tr key={r.id} className="border-b border-border/50">
                      <td className="py-1 pr-3">{r.roomNumber}</td><td className="py-1 pr-3">{r.roomType}</td>
                      <td className="py-1 pr-3">{money(r.rentMinor)}</td><td className="py-1 pr-3">{r.occupied}/{r.capacity}</td>
                      <td className="py-1"><Badge variant={r.available > 0 ? "secondary" : "outline"}>{r.available}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {canManage && (
              <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
                <div className="space-y-1.5"><Label>Room #</Label><Input className="w-24" value={roomFor === h.id ? rNum : ""} onFocusCapture={() => setRoomFor(h.id)} onChange={(e) => { setRoomFor(h.id); setRNum(e.target.value); }} /></div>
                <div className="space-y-1.5"><Label>Capacity</Label><Input className="w-20" type="number" min={1} value={rCap} onChange={(e) => setRCap(Number(e.target.value))} /></div>
                <div className="space-y-1.5"><Label>Rent (kobo)</Label><Input className="w-28" type="number" min={0} value={rRent} onChange={(e) => setRRent(Number(e.target.value))} /></div>
                <Button variant="outline" disabled={busy || roomFor !== h.id || !rNum} onClick={() => run(() => postSms(`hostels/${h.id}/rooms`, { roomNumber: rNum, roomType: "SHARED", capacity: rCap, rentMinor: rRent }), "Room added.")}>Add room</Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      {canManage && allRooms.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Allocate a student</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label>Room</Label>
              <select value={allocRoom} onChange={(e) => setAllocRoom(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">Select…</option>
                {allRooms.map((r) => <option key={r.id} value={r.id} disabled={r.available <= 0}>{r.hostelName} · {r.roomNumber} ({r.available} free)</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Student</Label>
              <select value={allocStudent} onChange={(e) => setAllocStudent(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <Button disabled={busy || !allocRoom || !allocStudent} onClick={() => run(() => postSms("hostels/allocations", { roomId: allocRoom, studentId: allocStudent }), "Student allocated.")}>Allocate</Button>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Schedule hostel fees</CardTitle>
            <CardDescription>Raises rent as invoice line items for active allocations — collected alongside academic fees.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label>Hostel</Label>
              <select value={feeHostel} onChange={(e) => setFeeHostel(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">All hostels</option>
                {hostels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5"><Label>Due date</Label><Input type="date" value={feeDue} onChange={(e) => setFeeDue(e.target.value)} /></div>
            <Button disabled={busy || !feeDue} onClick={() => run(() => postSms("hostels/fees/schedule", { hostelId: feeHostel || undefined, dueDate: new Date(feeDue).toISOString() }), "Hostel fees scheduled.")}>Schedule fees</Button>
          </CardContent>
        </Card>
      )}

      {allocations.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Current allocations</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Student</th><th className="py-1 pr-3 font-medium">Hostel</th>
                <th className="py-1 pr-3 font-medium">Room</th><th className="py-1 pr-3 font-medium">Rent</th>
                {canManage && <th className="py-1 font-medium"></th>}
              </tr></thead>
              <tbody>
                {allocations.map((a) => (
                  <tr key={a.id} className="border-b border-border/50">
                    <td className="py-1 pr-3">{a.studentName}</td><td className="py-1 pr-3">{a.hostelName}</td>
                    <td className="py-1 pr-3">{a.roomNumber}</td><td className="py-1 pr-3">{money(a.rentMinor)}</td>
                    {canManage && <td className="py-1"><Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => postSms(`hostels/allocations/${a.id}/vacate`, {}), "Vacated.")}>Vacate</Button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
