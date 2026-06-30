"use client";

// Transport Management UI. Admins maintain vehicles (capacity + custom fields like
// fuel/repair/licence), routes + stops (flat or stop-based fare), assign students/
// staff within seat availability, change routes (alerts parents), and schedule
// transport fees (billed alongside academic fees).

import type { VehicleDto, TransportRouteDto, TransportAssignmentDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";

type Vehicle = Serialized<VehicleDto>;
type Route = Serialized<TransportRouteDto>;
type Assignment = Serialized<TransportAssignmentDto>;
type Person = { id: string; name: string };

export function TransportManager({
  vehicles, routes, assignments, students, canManage,
}: {
  vehicles: Vehicle[]; routes: Route[]; assignments: Assignment[]; students: Person[]; canManage: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [vName, setVName] = React.useState("");
  const [vCap, setVCap] = React.useState(40);
  const [rName, setRName] = React.useState("");
  const [rVehicle, setRVehicle] = React.useState("");
  const [rMode, setRMode] = React.useState<"FLAT" | "STOP">("FLAT");
  const [rFare, setRFare] = React.useState(30000);
  const [aRoute, setARoute] = React.useState("");
  const [aStudent, setAStudent] = React.useState(students[0]?.id ?? "");
  const [feeRoute, setFeeRoute] = React.useState("");
  const [feeDue, setFeeDue] = React.useState("");

  const run = async (fn: () => Promise<{ ok: boolean; status: number; error: string | null }>, ok: string) => {
    setBusy(true); setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) { setMsg(ok); router.refresh(); } else setMsg(res.error ?? `Failed (${res.status}).`);
  };

  const activeRoutes = routes.filter((r) => r.status === "ACTIVE");

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      {canManage && (
        <Card>
          <CardHeader><CardTitle className="text-base">Add vehicle</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5"><Label>Name</Label><Input value={vName} onChange={(e) => setVName(e.target.value)} placeholder="Bus 1" /></div>
            <div className="space-y-1.5"><Label>Capacity</Label><Input className="w-24" type="number" min={0} value={vCap} onChange={(e) => setVCap(Number(e.target.value))} /></div>
            <Button disabled={busy || !vName} onClick={() => run(() => postSms("transport/vehicles", { name: vName, capacity: vCap }), "Vehicle added.")}>Add</Button>
          </CardContent>
        </Card>
      )}

      {vehicles.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Vehicles</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {vehicles.map((v) => <Badge key={v.id} variant="secondary" className="font-normal">{v.name} · {v.capacity} seats{v.regNumber ? ` · ${v.regNumber}` : ""}</Badge>)}
            </div>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader><CardTitle className="text-base">Create route</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5"><Label>Name</Label><Input value={rName} onChange={(e) => setRName(e.target.value)} placeholder="Lekki Run" /></div>
            <div className="space-y-1.5">
              <Label>Vehicle</Label>
              <select value={rVehicle} onChange={(e) => setRVehicle(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">None</option>
                {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Fare mode</Label>
              <select value={rMode} onChange={(e) => setRMode(e.target.value as "FLAT" | "STOP")} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="FLAT">Flat</option><option value="STOP">Per stop</option>
              </select>
            </div>
            {rMode === "FLAT" && <div className="space-y-1.5"><Label>Flat fare (kobo)</Label><Input className="w-28" type="number" min={0} value={rFare} onChange={(e) => setRFare(Number(e.target.value))} /></div>}
            <Button disabled={busy || !rName} onClick={() => run(() => postSms("transport/routes", { name: rName, vehicleId: rVehicle || undefined, fareMode: rMode, flatFareMinor: rMode === "FLAT" ? rFare : 0 }), "Route created.")}>Create</Button>
          </CardContent>
        </Card>
      )}

      {routes.map((r) => (
        <Card key={r.id}>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              {r.name} <Badge variant={r.status === "ACTIVE" ? "secondary" : "outline"}>{r.status}</Badge>
              {r.vehicleName && <span className="text-xs font-normal text-muted-foreground">{r.vehicleName}</span>}
            </CardTitle>
            <CardDescription>
              Fare: {r.fareMode === "FLAT" ? money(r.flatFareMinor) + " flat" : "per stop"} · Seats: {r.seatsAvailable} free / {r.capacity}
            </CardDescription>
          </CardHeader>
          {(r.stops.length > 0 || canManage) && (
            <CardContent className="space-y-2">
              {r.stops.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {r.stops.map((s) => <Badge key={s.id} variant="outline" className="font-normal">{s.name}{r.fareMode === "STOP" ? ` · ${money(s.fareMinor)}` : ""}{s.pickupTime ? ` · ${s.pickupTime}` : ""}</Badge>)}
                </div>
              )}
              {canManage && r.status === "ACTIVE" && (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { const name = prompt("Stop name?"); if (name) run(() => postSms(`transport/routes/${r.id}/stops`, { name, sequence: r.stops.length + 1, fareMinor: r.fareMode === "STOP" ? Number(prompt("Stop fare (kobo)?") ?? 0) : 0 }), "Stop added."); }}>Add stop</Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => postSms(`transport/routes/${r.id}/retire`, {}), "Route retired.")}>Retire route</Button>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      ))}

      {canManage && activeRoutes.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Assign a student to a route</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label>Route</Label>
              <select value={aRoute} onChange={(e) => setARoute(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">Select…</option>
                {activeRoutes.map((r) => <option key={r.id} value={r.id} disabled={r.capacity > 0 && r.seatsAvailable <= 0}>{r.name} ({r.seatsAvailable} free)</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Student</Label>
              <select value={aStudent} onChange={(e) => setAStudent(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <Button disabled={busy || !aRoute || !aStudent} onClick={() => run(() => postSms("transport/assignments", { routeId: aRoute, passengerId: aStudent, passengerType: "STUDENT" }), "Assigned.")}>Assign</Button>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Schedule transport fees</CardTitle>
            <CardDescription>Bills each assigned student's fare as an invoice line item — collected alongside academic fees.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label>Route</Label>
              <select value={feeRoute} onChange={(e) => setFeeRoute(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">All routes</option>
                {routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5"><Label>Due date</Label><Input type="date" value={feeDue} onChange={(e) => setFeeDue(e.target.value)} /></div>
            <Button disabled={busy || !feeDue} onClick={() => run(() => postSms("transport/fees/schedule", { routeId: feeRoute || undefined, dueDate: new Date(feeDue).toISOString() }), "Transport fees scheduled.")}>Schedule fees</Button>
          </CardContent>
        </Card>
      )}

      {assignments.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Current assignments</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Passenger</th><th className="py-1 pr-3 font-medium">Route</th>
                <th className="py-1 pr-3 font-medium">Fare</th>{canManage && <th className="py-1 font-medium"></th>}
              </tr></thead>
              <tbody>
                {assignments.map((a) => (
                  <tr key={a.id} className="border-b border-border/50">
                    <td className="py-1 pr-3">{a.passengerName}</td><td className="py-1 pr-3">{a.routeName}</td>
                    <td className="py-1 pr-3">{money(a.fareMinor)}</td>
                    {canManage && <td className="py-1"><Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => postSms(`transport/assignments/${a.id}/cancel`, {}), "Cancelled.")}>Cancel</Button></td>}
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
