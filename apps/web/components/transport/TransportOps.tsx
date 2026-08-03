"use client";

import type { TransportRouteDto, TransportTripDto, TransportBoardingDto, VehicleMaintenanceDto, VehicleLocationDto, VehicleDto, TransportAssignmentDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";
import { shortDate } from "@/lib/format";

type Route = Serialized<TransportRouteDto>;
type Vehicle = Serialized<VehicleDto>;
type Assignment = Serialized<TransportAssignmentDto>;
const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const today = () => new Date().toISOString().slice(0, 10);
const naira = (m: number) => `₦${(m / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(`/api/sms${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, status: res.status, data: res.ok ? await res.json().catch(() => null) : null, error: res.ok ? null : await readApiError(res) };
}

/** Operational transport tools: AM/PM trips, boarding confirmation (parent
 *  alerts), the maintenance/fuel log, and the live GPS fleet view. */
export function TransportOps({ routes, vehicles, assignments, canManage }: {
  routes: Route[];
  vehicles: Vehicle[];
  assignments: Assignment[];
  canManage: boolean;
}) {
  const [msg, setMsg] = React.useState<string | null>(null);
  return (
    <div className="space-y-4">
      {msg && <p className="rounded-md bg-muted px-3 py-2 text-sm">{msg}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <BoardingPanel routes={routes} assignments={assignments} onMsg={setMsg} />
        <GpsPanel vehicles={vehicles} canManage={canManage} onMsg={setMsg} />
        {canManage && <TripsPanel routes={routes} onMsg={setMsg} />}
        {canManage && <MaintenancePanel vehicles={vehicles} onMsg={setMsg} />}
      </div>
    </div>
  );
}

function BoardingPanel({ routes, assignments, onMsg }: { routes: Route[]; assignments: Assignment[]; onMsg: (s: string) => void }) {
  const [routeId, setRouteId] = React.useState(routes[0]?.id ?? "");
  const [date, setDate] = React.useState(today());
  const [direction, setDirection] = React.useState("PICKUP");
  const [rows, setRows] = React.useState<Serialized<TransportBoardingDto>[]>([]);
  const routePassengers = assignments.filter((a) => a.routeId === routeId && a.status === "ACTIVE");
  const load = React.useCallback(async () => {
    if (!routeId) return;
    const r = await fetch(`/api/sms/transport/boardings?routeId=${routeId}&date=${date}`);
    if (r.ok) setRows(await r.json());
  }, [routeId, date]);
  React.useEffect(() => { void load(); }, [load]);
  const boarded = new Map(rows.filter((b) => b.direction === direction).map((b) => [b.passengerId, b.status]));
  const record = async (passengerId: string, status: string) => {
    const r = await send("POST", "/transport/boardings", { routeId, passengerId, direction, date, status });
    onMsg(r.ok ? (status === "BOARDED" && direction === "PICKUP" ? "Boarded — guardians alerted." : "Recorded.") : (r.error ?? "Failed."));
    void load();
  };
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Boarding confirmation</CardTitle><CardDescription>A pickup alerts the child&apos;s guardians.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <select className={sel} value={routeId} onChange={(e) => setRouteId(e.target.value)}>{routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          <Input type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
          <select className={sel} value={direction} onChange={(e) => setDirection(e.target.value)}><option value="PICKUP">Pickup</option><option value="DROPOFF">Drop-off</option></select>
        </div>
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {routePassengers.length === 0 && <p className="text-sm text-muted-foreground">No passengers assigned to this route.</p>}
          {routePassengers.map((a) => {
            const st = boarded.get(a.passengerId);
            return (
              <div key={a.id} className="flex items-center justify-between gap-2 text-sm">
                <span>{a.passengerName} {st === "BOARDED" && <Badge variant="secondary">boarded</Badge>}{st === "ABSENT" && <Badge variant="destructive">absent</Badge>}</span>
                <span className="flex gap-1">
                  <Button size="sm" variant={st === "BOARDED" ? "secondary" : "outline"} className="h-7" onClick={() => record(a.passengerId, "BOARDED")}>Boarded</Button>
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => record(a.passengerId, "ABSENT")}>Absent</Button>
                  {/* Move a pupil to another route. The endpoint existed with no
                      control, so the only way was to cancel and re-assign —
                      which loses the assignment's history. */}
                  <select
                    className={sel + " h-7"}
                    value=""
                    aria-label={`Move ${a.passengerName} to another route`}
                    onChange={async (e) => {
                      const to = e.target.value;
                      if (!to) return;
                      const r = await send("POST", `/transport/assignments/${a.id}/change-route`, { routeId: to });
                      onMsg(r.ok ? `${a.passengerName} moved.` : r.error ?? "Could not move.");
                    }}
                  >
                    <option value="">Move to…</option>
                    {routes.filter((r) => r.id !== routeId).map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function GpsPanel({ vehicles, canManage, onMsg }: { vehicles: Vehicle[]; canManage: boolean; onMsg: (s: string) => void }) {
  const [locs, setLocs] = React.useState<Serialized<VehicleLocationDto>[]>([]);
  const [vehicleId, setVehicleId] = React.useState(vehicles[0]?.id ?? "");
  const [lat, setLat] = React.useState("");
  const [lng, setLng] = React.useState("");
  const load = React.useCallback(async () => {
    const r = await fetch("/api/sms/transport/locations");
    if (r.ok) setLocs(await r.json());
  }, []);
  React.useEffect(() => {
    void load();
    const t = setInterval(load, 15000); // refresh the live map every 15s
    return () => clearInterval(t);
  }, [load]);
  const push = async () => {
    const r = await send("POST", "/transport/locations", { vehicleId, lat: Number(lat), lng: Number(lng) });
    onMsg(r.ok ? "Location updated." : (r.error ?? "Failed."));
    void load();
  };
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Live fleet (GPS)</CardTitle><CardDescription>Latest known position per vehicle (auto-refreshes).</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {locs.length === 0 && <p className="text-sm text-muted-foreground">No location pings yet.</p>}
          {locs.map((l) => (
            <div key={l.vehicleId} className="flex items-center justify-between gap-2 text-sm">
              <span>{l.vehicleName}</span>
              <a href={`https://www.google.com/maps?q=${l.lat},${l.lng}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-primary underline">
                {l.lat.toFixed(4)}, {l.lng.toFixed(4)}
              </a>
              <span className="text-xs text-muted-foreground">{new Date(l.recordedAt).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
        {canManage && (
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-2">
            <span className="text-xs text-muted-foreground">Post a ping (device/driver app):</span>
            <select className={sel} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
            <Input placeholder="lat" value={lat} onChange={(e) => setLat(e.target.value)} className="w-24" />
            <Input placeholder="lng" value={lng} onChange={(e) => setLng(e.target.value)} className="w-24" />
            <Button size="sm" variant="outline" disabled={!lat || !lng} onClick={push}>Ping</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TripsPanel({ routes, onMsg }: { routes: Route[]; onMsg: (s: string) => void }) {
  const [list, setList] = React.useState<Serialized<TransportTripDto>[]>([]);
  const [routeId, setRouteId] = React.useState(routes[0]?.id ?? "");
  const [direction, setDirection] = React.useState("AM_PICKUP");
  const [departTime, setDepartTime] = React.useState("07:30");
  const load = React.useCallback(async () => {
    const r = await fetch("/api/sms/transport/trips");
    if (r.ok) setList(await r.json());
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  const create = async () => {
    const r = await send("POST", "/transport/trips", { routeId, direction, departTime });
    onMsg(r.ok ? "Trip scheduled." : (r.error ?? "Failed."));
    void load();
  };
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Trip schedule</CardTitle><CardDescription>Morning pickup / afternoon drop-off times per route.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <select className={sel} value={routeId} onChange={(e) => setRouteId(e.target.value)}>{routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          <select className={sel} value={direction} onChange={(e) => setDirection(e.target.value)}><option value="AM_PICKUP">AM pickup</option><option value="PM_DROPOFF">PM drop-off</option></select>
          <Input type="time" value={departTime} onChange={(e) => setDepartTime(e.target.value)} className="w-28" />
          <Button size="sm" onClick={create}>Add trip</Button>
        </div>
        <div className="max-h-40 space-y-1 overflow-y-auto border-t border-border pt-2">
          {list.length === 0 && <p className="text-sm text-muted-foreground">No trips yet.</p>}
          {list.map((t) => (
            <div key={t.id} className="text-sm">{t.routeName} · <Badge variant="outline">{t.direction === "AM_PICKUP" ? "AM" : "PM"}</Badge> {t.departTime} <span className="text-xs text-muted-foreground">{t.daysOfWeek.join(", ")}</span></div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function MaintenancePanel({ vehicles, onMsg }: { vehicles: Vehicle[]; onMsg: (s: string) => void }) {
  const [list, setList] = React.useState<Serialized<VehicleMaintenanceDto>[]>([]);
  const [vehicleId, setVehicleId] = React.useState(vehicles[0]?.id ?? "");
  const [type, setType] = React.useState("SERVICE");
  const [date, setDate] = React.useState(today());
  const [cost, setCost] = React.useState("");
  const [litres, setLitres] = React.useState("");
  const load = React.useCallback(async () => {
    const r = await fetch("/api/sms/transport/maintenance");
    if (r.ok) setList(await r.json());
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  const add = async () => {
    const r = await send("POST", "/transport/maintenance", {
      vehicleId, type, date,
      costMinor: Math.round(Number(cost || 0) * 100),
      litres: type === "FUEL" && litres ? Number(litres) : null,
    });
    onMsg(r.ok ? "Logged." : (r.error ?? "Failed."));
    if (r.ok) { setCost(""); setLitres(""); void load(); }
  };
  const TYPES = ["SERVICE", "REPAIR", "FUEL", "INSPECTION", "INSURANCE"];
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Maintenance & fuel log</CardTitle><CardDescription>Service, repair, fuel and inspection records + cost.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <select className={sel} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
          <select className={sel} value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{t[0] + t.slice(1).toLowerCase()}</option>)}</select>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-36" />
          <Input placeholder="cost ₦" value={cost} onChange={(e) => setCost(e.target.value)} className="w-24" />
          {type === "FUEL" && <Input placeholder="litres" value={litres} onChange={(e) => setLitres(e.target.value)} className="w-20" />}
          <Button size="sm" onClick={add}>Log</Button>
        </div>
        <div className="max-h-40 space-y-1 overflow-y-auto border-t border-border pt-2">
          {list.length === 0 && <p className="text-sm text-muted-foreground">No records.</p>}
          {list.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-2 text-sm">
              <span>{m.vehicleName} · <Badge variant="outline">{m.type.toLowerCase()}</Badge> {shortDate(m.date)}{m.litres ? ` · ${m.litres}L` : ""}</span>
              <span className="tabular-nums">{naira(m.costMinor)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
