"use client";

// Transport Management UI. Admins maintain vehicles (capacity + custom fields like
// fuel/repair/licence), routes + stops (flat or stop-based fare), assign students/
// staff within seat availability, change routes (alerts parents), and schedule
// transport fees (billed alongside academic fees).

import type { VehicleDto, TransportRouteDto, TransportAssignmentDto, Serialized } from "@sms/types";
import { StudentPicker } from "@/components/people/StudentPicker";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postSms, sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { useFormat } from "@/components/shell/RegionProvider";
import { personLabel } from "@/lib/people";

type Vehicle = Serialized<VehicleDto>;
type Route = Serialized<TransportRouteDto>;
type Assignment = Serialized<TransportAssignmentDto>;
type Person = { id: string; name: string; roles?: string[] };

export function TransportManager({
  vehicles, routes, assignments, students, staff = [], canManage,
}: {
  vehicles: Vehicle[]; routes: Route[]; assignments: Assignment[]; students: Person[]; staff?: Person[]; canManage: boolean;
}) {
  // The SCHOOL's currency, not the platform's. `money` from `@/lib/format`
  // defaults to `PLATFORM_REGION.currency`, so these read in naira for a school
  // that bills in anything else — the region rides the session and
  // `useFormat()` is how a client island gets at it.
  const { money, minorFrom, majorFrom, region } = useFormat();
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [vName, setVName] = React.useState("");
  const [vCap, setVCap] = React.useState(40);
  const [vDriver, setVDriver] = React.useState("");
  const [rName, setRName] = React.useState("");
  const [rVehicle, setRVehicle] = React.useState("");
  const [rMode, setRMode] = React.useState<"FLAT" | "STOP">("FLAT");
  // MAJOR units, in the school's currency. This was a raw minor-unit box
  // labelled "(kobo)" — so a bursar typed 30000 to mean three hundred naira, and
  // in a school billing anything else the label named a unit that does not
  // exist there. `minorFrom` is the shared converter and follows the region.
  const [rFare, setRFare] = React.useState("300");
  const [aRoute, setARoute] = React.useState("");
  const [aStop, setAStop] = React.useState("");
  const [aStudent, setAStudent] = React.useState(students[0]?.id ?? "");
  // Per-route drafts for adding a stop, replacing three chained `prompt()`
  // dialogs — which cannot be labelled for a screen reader, cannot validate, and
  // asked for the fare in kobo.
  const [stopDraft, setStopDraft] = React.useState<Record<string, { name: string; fare: string; time: string }>>({});
  const draftFor = (id: string) => stopDraft[id] ?? { name: "", fare: "", time: "" };
  const setDraft = (id: string, patch: Partial<{ name: string; fare: string; time: string }>) =>
    setStopDraft((m) => ({ ...m, [id]: { ...draftFor(id), ...patch } }));
  // Per-route fare edit. A route's mode could be chosen at creation and never
  // corrected, so a school that picked wrong had to retire it and re-assign
  // every rider.
  const [fareEdit, setFareEdit] = React.useState<Record<string, { mode: "FLAT" | "STOP"; fare: string }>>({});
  const [feeRoute, setFeeRoute] = React.useState("");
  const [feeDue, setFeeDue] = React.useState("");

  const run = async (fn: () => Promise<{ ok: boolean; status: number; error: string | null }>, ok: string) => {
    setBusy(true); setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) { setMsg(ok); router.refresh(); } else setMsg(res.error ?? "Request failed.");
  };

  // Reorder by swapping a stop with its neighbour and sending the full id list —
  // the server sets sequence from position, so no number is ever typed.
  const moveStop = (r: Route, index: number, dir: -1 | 1) => {
    const ids = r.stops.map((s) => s.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    void run(() => postSms(`transport/routes/${r.id}/stops/reorder`, { orderedIds: ids }), "Stops reordered.");
  };

  const activeRoutes = routes.filter((r) => r.status === "ACTIVE");
  /**
   * Riders a fee run would pass over.
   *
   * On a per-stop route the fare lives on the rider's STOP, so a rider without
   * one prices at zero and the run skips them in silence. The API reports this
   * as `unpriced`; saying it HERE is what stops it being created — the assign
   * form below refuses to leave the stop blank on such a route.
   */
  const unpricedOn = (r: Route) =>
    r.fareMode !== "STOP"
      ? 0
      : assignments.filter(
          (a) => a.routeId === r.id && a.status === "ACTIVE" && a.passengerType === "STUDENT" && !a.stopId,
        ).length;
  const routeById = new Map(routes.map((r) => [r.id, r]));
  const chosenRoute = routeById.get(aRoute) ?? null;
  const needsStop = chosenRoute?.fareMode === "STOP";

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      {canManage && (
        <Card>
          <CardHeader><CardTitle className="text-base">Add vehicle</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5"><Label>Name</Label><Input value={vName} onChange={(e) => setVName(e.target.value)} placeholder="Bus 1" /></div>
            <div className="space-y-1.5"><Label>Capacity</Label><Input className="w-24" type="number" min={0} value={vCap} onChange={(e) => setVCap(Number(e.target.value))} /></div>
            <div className="space-y-1.5">
              <Label>Driver</Label>
              <select aria-label="Driver" value={vDriver} onChange={(e) => setVDriver(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">— none —</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{personLabel(s)}</option>)}
              </select>
            </div>
            <Button disabled={busy || !vName} onClick={() => run(() => postSms("transport/vehicles", { name: vName, capacity: vCap, driverId: vDriver || null }), "Vehicle added.")}>Add</Button>
          </CardContent>
        </Card>
      )}

      {vehicles.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Vehicles</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {vehicles.map((v) => (
                <span key={v.id} className="inline-flex items-center gap-1">
                  <Badge variant="secondary" className="font-normal">{v.name} · {v.capacity} seats{v.regNumber ? ` · ${v.regNumber}` : ""}</Badge>
                  {canManage && (
                    <>
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" disabled={busy} onClick={() => {
                        const name = prompt("New vehicle name?", v.name);
                        if (name?.trim()) void run(() => sendSms("PUT", `transport/vehicles/${v.id}`, { name: name.trim() }), "Vehicle renamed.");
                      }}>Rename</Button>
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-destructive" disabled={busy} onClick={() => {
                        if (!confirm(`Delete "${v.name}"? Only possible if no route uses it.`)) return;
                        void run(() => sendSms("DELETE", `transport/vehicles/${v.id}`), "Vehicle deleted.");
                      }}>Delete</Button>
                    </>
                  )}
                </span>
              ))}
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
              <select aria-label="Vehicle" value={rVehicle} onChange={(e) => setRVehicle(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">None</option>
                {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Fare mode</Label>
              <select aria-label="Route mode" value={rMode} onChange={(e) => setRMode(e.target.value as "FLAT" | "STOP")} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="FLAT">Flat</option><option value="STOP">Per stop</option>
              </select>
            </div>
            {rMode === "FLAT" && (
              <div className="space-y-1.5">
                <Label htmlFor="r-fare">Flat fare ({region.currency})</Label>
                <Input id="r-fare" className="w-28" inputMode="decimal" value={rFare} onChange={(e) => setRFare(e.target.value)} />
              </div>
            )}
            <Button disabled={busy || !rName} onClick={() => run(() => postSms("transport/routes", { name: rName, vehicleId: rVehicle || undefined, fareMode: rMode, flatFareMinor: rMode === "FLAT" ? minorFrom(rFare || 0) : 0 }), "Route created.")}>Create</Button>
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
                canManage ? (
                  // Ordered list with arrows — the stop ORDER is set here, never by
                  // typing a number; the server appends new stops and reorder sends
                  // the whole id list.
                  <ol className="space-y-1">
                    {r.stops.map((s, i) => (
                      <li key={s.id} className="flex items-center gap-2 text-sm">
                        <span className="w-5 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
                        <span className="flex-1">{s.name}{r.fareMode === "STOP" ? ` · ${money(s.fareMinor)}` : ""}{s.pickupTime ? ` · ${s.pickupTime}` : ""}</span>
                        <button aria-label="Move up" disabled={busy || i === 0} className="px-1 text-muted-foreground disabled:opacity-30" onClick={() => moveStop(r, i, -1)}>↑</button>
                        <button aria-label="Move down" disabled={busy || i === r.stops.length - 1} className="px-1 text-muted-foreground disabled:opacity-30" onClick={() => moveStop(r, i, 1)}>↓</button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {r.stops.map((s) => <Badge key={s.id} variant="outline" className="font-normal">{s.name}{r.fareMode === "STOP" ? ` · ${money(s.fareMinor)}` : ""}{s.pickupTime ? ` · ${s.pickupTime}` : ""}</Badge>)}
                  </div>
                )
              )}
              {/* SAYS WHO WOULD NOT BE BILLED, on the screen where it can be
                  put right. A per-stop route whose riders have no stop bills
                  none of them, and the fee run's own "would bill nobody" reads
                  exactly like an empty route. */}
              {unpricedOn(r) > 0 && (
                <p className="text-sm text-destructive">
                  {unpricedOn(r)} rider{unpricedOn(r) === 1 ? " has" : "s have"} no stop on this per-stop
                  route, so a fee run would not bill {unpricedOn(r) === 1 ? "them" : "them"}. Set each
                  rider&apos;s stop from the Transport page, or give this route a flat fare below.
                </p>
              )}
              {canManage && r.status === "ACTIVE" && (
                <div className="flex flex-wrap items-end gap-2">
                  {/* A REAL FORM, not three chained prompt() dialogs: those
                      cannot be labelled for a screen reader, cannot validate,
                      and asked for the fare in kobo. */}
                  <div className="space-y-1.5">
                    <Label htmlFor={`stop-name-${r.id}`}>New stop</Label>
                    <Input
                      id={`stop-name-${r.id}`}
                      className="w-40"
                      placeholder="Stop name"
                      value={draftFor(r.id).name}
                      onChange={(e) => setDraft(r.id, { name: e.target.value })}
                    />
                  </div>
                  {r.fareMode === "STOP" && (
                    <div className="space-y-1.5">
                      <Label htmlFor={`stop-fare-${r.id}`}>Fare ({region.currency})</Label>
                      <Input
                        id={`stop-fare-${r.id}`}
                        className="w-28"
                        inputMode="decimal"
                        value={draftFor(r.id).fare}
                        onChange={(e) => setDraft(r.id, { fare: e.target.value })}
                      />
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor={`stop-time-${r.id}`}>Pickup</Label>
                    <Input
                      id={`stop-time-${r.id}`}
                      className="w-28"
                      type="time"
                      value={draftFor(r.id).time}
                      onChange={(e) => setDraft(r.id, { time: e.target.value })}
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !draftFor(r.id).name.trim()}
                    onClick={() =>
                      run(
                        () =>
                          postSms(`transport/routes/${r.id}/stops`, {
                            name: draftFor(r.id).name.trim(),
                            fareMinor: r.fareMode === "STOP" ? minorFrom(draftFor(r.id).fare || 0) : 0,
                            pickupTime: draftFor(r.id).time || null,
                          }),
                        "Stop added.",
                      ).then(() => setStopDraft((m) => ({ ...m, [r.id]: { name: "", fare: "", time: "" } })))
                    }
                  >
                    Add stop
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => {
                    const name = prompt("New route name?", r.name);
                    if (name?.trim()) void run(() => sendSms("PUT", `transport/routes/${r.id}`, { name: name.trim() }), "Route renamed.");
                  }}>Rename</Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => postSms(`transport/routes/${r.id}/retire`, {}), "Route retired.")}>Retire route</Button>
                </div>
              )}
              {/* THE FARE IS CORRECTABLE. It could be chosen once at creation
                  and never changed, so a school that picked the wrong mode had
                  to retire the route and re-assign every rider — losing the
                  assignments the fares hang off. */}
              {canManage && r.status === "ACTIVE" && (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`fare-mode-${r.id}`}>Fare mode</Label>
                    <select
                      id={`fare-mode-${r.id}`}
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                      value={fareEdit[r.id]?.mode ?? (r.fareMode === "STOP" ? "STOP" : "FLAT")}
                      onChange={(e) =>
                        setFareEdit((m) => ({
                          ...m,
                          [r.id]: {
                            mode: e.target.value as "FLAT" | "STOP",
                            fare: m[r.id]?.fare ?? String(majorFrom(r.flatFareMinor)),
                          },
                        }))
                      }
                    >
                      <option value="FLAT">Flat</option>
                      <option value="STOP">Per stop</option>
                    </select>
                  </div>
                  {(fareEdit[r.id]?.mode ?? r.fareMode) === "FLAT" && (
                    <div className="space-y-1.5">
                      <Label htmlFor={`fare-amt-${r.id}`}>Flat fare ({region.currency})</Label>
                      <Input
                        id={`fare-amt-${r.id}`}
                        className="w-28"
                        inputMode="decimal"
                        value={fareEdit[r.id]?.fare ?? String(majorFrom(r.flatFareMinor))}
                        onChange={(e) =>
                          setFareEdit((m) => ({
                            ...m,
                            [r.id]: { mode: m[r.id]?.mode ?? (r.fareMode === "STOP" ? "STOP" : "FLAT"), fare: e.target.value },
                          }))
                        }
                      />
                    </div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !fareEdit[r.id]}
                    onClick={() => {
                      const edit = fareEdit[r.id]!;
                      void run(
                        () =>
                          sendSms("PUT", `transport/routes/${r.id}`, {
                            fareMode: edit.mode,
                            ...(edit.mode === "FLAT" ? { flatFareMinor: minorFrom(edit.fare || 0) } : {}),
                          }),
                        "Fare updated.",
                      ).then(() => setFareEdit((m) => { const n = { ...m }; delete n[r.id]; return n; }));
                    }}
                  >
                    Save fare
                  </Button>
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
              <select aria-label="Route" value={aRoute} onChange={(e) => setARoute(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">Select…</option>
                {activeRoutes.map((r) => <option key={r.id} value={r.id} disabled={r.capacity > 0 && r.seatsAvailable <= 0}>{r.name} ({r.seatsAvailable} free)</option>)}
              </select>
            </div>
            {/* THE STOP, on a per-stop route, is what the fare comes from.
                This form never sent one, so every rider assigned through the
                product carried `stopId: null` — and on such a route that prices
                at zero and the fee run skips them without a word. Required
                here rather than optional, because there is no correct way to
                leave it blank on a route whose fares live on its stops. */}
            {needsStop && (chosenRoute?.stops ?? []).length === 0 && (
              <p className="w-full text-sm text-destructive">
                This route charges by stop and has no stops yet. Add one above before assigning riders,
                or nobody on it can be billed.
              </p>
            )}
            {needsStop && (chosenRoute?.stops ?? []).length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="a-stop">Stop</Label>
                <select
                  id="a-stop"
                  value={aStop}
                  onChange={(e) => setAStop(e.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Select…</option>
                  {(chosenRoute?.stops ?? []).map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name} · {money(st.fareMinor)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Student</Label>
              {/* Searched, not enumerated: the roster list is bounded, so a
    dropdown built from it would silently omit people. */}
<StudentPicker value={aStudent} onChange={(id) => setAStudent(id)} seed={students} />
            </div>
            <Button
              disabled={busy || !aRoute || !aStudent || (needsStop && !aStop)}
              title={needsStop && !aStop ? "This route charges by stop — choose one" : undefined}
              onClick={() =>
                run(
                  () =>
                    postSms("transport/assignments", {
                      routeId: aRoute,
                      stopId: needsStop ? aStop : undefined,
                      passengerId: aStudent,
                      passengerType: "STUDENT",
                    }),
                  "Assigned.",
                ).then(() => setAStop(""))
              }
            >
              Assign
            </Button>
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
              <select aria-label="Route" value={feeRoute} onChange={(e) => setFeeRoute(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">All routes</option>
                {routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5"><Label>Due date</Label><Input type="date" value={feeDue} onChange={(e) => setFeeDue(e.target.value)} /></div>
            <Button disabled={busy || !feeDue} onClick={async () => {
              setMsg(null);
              const res = await postSms<{ pendingApproval?: boolean }>("transport/fees/schedule", { routeId: feeRoute || undefined, dueDate: new Date(feeDue).toISOString() });
              if (res.ok && res.data?.pendingApproval) setMsg("Submitted for approval — a school admin or principal must approve this fee run before any invoice is posted (maker-checker).");
              else if (res.ok) { setMsg("Transport fees scheduled."); router.refresh(); }
              else setMsg(res.error ?? "Request failed.");
            }}>Schedule fees</Button>
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
                    <td className="py-1 pr-3">
                      {/* Null for a reader who may not see what a family pays —
                          a driver holds transport.read and nothing else. */}
                      {a.fareMinor === null ? <span className="text-muted-foreground">—</span> : money(a.fareMinor)}
                    </td>
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
