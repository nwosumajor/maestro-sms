"use client";

// =============================================================================
// AttendanceAdmin — staff register (Mode A) + clock-in kiosk (Mode B) admin
// =============================================================================
// hr.write marks/corrects the day's register; the kiosk card manages the
// rotating-code display (the TOTP secret never reaches the browser — only the
// current 6-digit code, which is exactly what the gate screen shows). Flagged
// rows are SIGNALS (off-site IP etc.) for a human to review — never a penalty.
// =============================================================================

import type { AttendanceRegisterDto, AttendanceSummaryDto, KioskConfigDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Register = Serialized<AttendanceRegisterDto>;
type Summary = Serialized<AttendanceSummaryDto>;

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

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  PRESENT: "default",
  LATE: "secondary",
  ABSENT: "destructive",
};

export function AttendanceAdmin({
  initialRegister,
  initialKiosk,
  initialSummary,
  canWrite,
}: {
  initialRegister: Register | null;
  initialKiosk: Serialized<KioskConfigDto> | null;
  initialSummary: Summary | null;
  canWrite: boolean;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = React.useState(today);
  const [register, setRegister] = React.useState<Register | null>(initialRegister);
  const [err, setErr] = React.useState<string | null>(null);

  async function loadRegister(d: string) {
    const r = await req("GET", `/hr/attendance/register/${d}`);
    if (r.ok) setRegister(r.data as Register);
    else setErr(r.error);
  }

  async function mark(userId: string, status: string) {
    setErr(null);
    const r = await req("POST", `/hr/attendance/mark`, { userId, date, status });
    if (r.ok) void loadRegister(date);
    else setErr(r.error);
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily register</CardTitle>
          <CardDescription>
            Mark each staff member present, late or absent. Kiosk clock-ins land here automatically; a
            ⚑ flag means the clock-in looked off-site — check with the person.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="att-date">Date</Label>
              <Input id="att-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
            </div>
            <Button size="sm" variant="outline" onClick={() => loadRegister(date)}>
              Load
            </Button>
          </div>

          {!register || register.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active staff records yet.</p>
          ) : (
            <ul className="space-y-1">
              {register.rows.map((r) => (
                <li key={r.userId} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                  <span className="min-w-[10rem] font-medium">{r.userName}</span>
                  {r.mark ? (
                    <>
                      <Badge variant={STATUS_VARIANT[r.mark.status] ?? "secondary"}>{r.mark.status.toLowerCase()}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {r.mark.source === "SELF_KIOSK" ? "kiosk" : r.mark.source.toLowerCase()}
                        {r.mark.clockInAt &&
                          ` · ${new Date(r.mark.clockInAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
                      </span>
                      {r.mark.flagged && <Badge variant="destructive">⚑ review</Badge>}
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">unmarked</span>
                  )}
                  {canWrite && (
                    <span className="ml-auto inline-flex gap-1">
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => mark(r.userId, "PRESENT")}>
                        P
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => mark(r.userId, "LATE")}>
                        L
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => mark(r.userId, "ABSENT")}>
                        A
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {err && <p className="text-sm text-destructive">{err}</p>}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <KioskCard initial={initialKiosk} canWrite={canWrite} />
        <SummaryCard initial={initialSummary} />
      </div>
    </div>
  );
}

function KioskCard({ initial, canWrite }: { initial: Serialized<KioskConfigDto> | null; canWrite: boolean }) {
  const [cfg, setCfg] = React.useState(initial);
  const [code, setCode] = React.useState<{ code: string; secondsRemaining: number } | null>(null);
  const [showDisplay, setShowDisplay] = React.useState(false);
  const [ips, setIps] = React.useState(initial?.allowedIps ?? "");
  const [lateAfter, setLateAfter] = React.useState(initial?.lateAfter ?? "08:00");
  const [err, setErr] = React.useState<string | null>(null);

  // Poll the rotating code while the display is open.
  React.useEffect(() => {
    if (!showDisplay) return;
    let alive = true;
    const tick = async () => {
      const r = await req("GET", `/hr/attendance/kiosk/code`);
      if (alive && r.ok) setCode(r.data as { code: string; secondsRemaining: number });
    };
    void tick();
    const iv = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [showDisplay]);

  async function save(patch: Record<string, unknown>) {
    setErr(null);
    const r = await req("PUT", `/hr/attendance/kiosk`, patch);
    if (r.ok) setCfg(r.data as Serialized<KioskConfigDto>);
    else setErr(r.error);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Clock-in kiosk</CardTitle>
        <CardDescription>
          Put this rotating code on a screen at the gate — staff must read it off the display to clock in, which
          proves they’re physically at school. Rotate the secret any time to invalidate old codes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge variant={cfg?.enabled ? "default" : "outline"}>{cfg?.enabled ? "enabled" : "disabled"}</Badge>
          {canWrite && (
            <>
              <Button size="sm" variant="outline" onClick={() => save({ enabled: !cfg?.enabled })}>
                {cfg?.enabled ? "Disable" : "Enable"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => save({ rotateSecret: true })}>
                Rotate secret
              </Button>
            </>
          )}
        </div>

        {cfg?.enabled && (
          <div>
            <Button size="sm" variant="outline" onClick={() => setShowDisplay((v) => !v)}>
              {showDisplay ? "Hide display code" : "Show display code"}
            </Button>
            {showDisplay && code && (
              <div className="mt-2 rounded-md border bg-muted/40 p-4 text-center">
                <div className="font-mono text-4xl font-bold tracking-[0.3em]">{code.code}</div>
                <div className="mt-1 text-xs text-muted-foreground">refreshes every 30s</div>
              </div>
            )}
          </div>
        )}

        {canWrite && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs">School network IPs (comma-sep; blank = no flagging)</Label>
                <Input className="w-64" value={ips} onChange={(e) => setIps(e.target.value)} placeholder="e.g. 197.210." />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Late after</Label>
                <Input className="w-24" value={lateAfter} onChange={(e) => setLateAfter(e.target.value)} placeholder="08:00" />
              </div>
              <Button size="sm" onClick={() => save({ allowedIps: ips || null, lateAfter })}>
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Window {cfg?.windowStart}–{cfg?.windowEnd}. An off-network clock-in is flagged for review, never blocked.
            </p>
          </div>
        )}
        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}

function SummaryCard({ initial }: { initial: Summary | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">This month</CardTitle>
        <CardDescription>Marks per staff member — a signal for follow-up, not a scorecard.</CardDescription>
      </CardHeader>
      <CardContent>
        {!initial || initial.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No marks recorded this month yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-1.5 pr-2">Staff</th>
                <th className="px-2">Present</th>
                <th className="px-2">Late</th>
                <th className="px-2">Absent</th>
                <th className="px-2">Flagged</th>
              </tr>
            </thead>
            <tbody>
              {initial.rows.map((r) => (
                <tr key={r.userId} className="border-b last:border-0">
                  <td className="py-1.5 pr-2 font-medium">{r.userName}</td>
                  <td className="px-2 tabular-nums">{r.present}</td>
                  <td className="px-2 tabular-nums">{r.late}</td>
                  <td className="px-2 tabular-nums">{r.absent}</td>
                  <td className="px-2 tabular-nums">{r.flagged > 0 ? `⚑ ${r.flagged}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

/** Mode C: biometric terminals — register (secret shown ONCE), map device user
 *  codes to staff, decommission. Templates never enter the system. */
export function BiometricAdmin({ staff, canWrite }: { staff: { userId: string; userName: string }[]; canWrite: boolean }) {
  type Device = { id: string; name: string; deviceId: string; enabled: boolean; lastSeenAt: string | null };
  type Enrollment = { id: string; deviceUserId: string; userId: string; userName: string | null };
  const [devices, setDevices] = React.useState<Device[]>([]);
  const [enrollments, setEnrollments] = React.useState<Enrollment[]>([]);
  const [newName, setNewName] = React.useState("");
  const [oneTimeSecret, setOneTimeSecret] = React.useState<{ deviceId: string; secret: string } | null>(null);
  const [code, setCode] = React.useState("");
  const [who, setWho] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const [d, e] = await Promise.all([req("GET", `/hr/attendance/devices`), req("GET", `/hr/attendance/enrollments`)]);
    if (d.ok) setDevices(d.data as Device[]);
    if (e.ok) setEnrollments(e.data as Enrollment[]);
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  async function register() {
    if (!newName.trim()) return;
    setErr(null);
    const r = await req("POST", `/hr/attendance/devices`, { name: newName.trim() });
    if (r.ok) {
      const d = r.data as { deviceId: string; secret: string };
      setOneTimeSecret(d);
      setNewName("");
      void load();
    } else setErr(r.error);
  }

  async function enroll() {
    if (!code.trim() || !who) return;
    setErr(null);
    const r = await req("POST", `/hr/attendance/enrollments`, { deviceUserId: code.trim(), userId: who });
    if (r.ok) {
      setCode("");
      void load();
    } else setErr(r.error);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Biometric terminals</CardTitle>
        <CardDescription>
          Fingerprint/face clocks at the gate push signed attendance events here. Fingerprints never leave
          the device — we store only who clocked in, and when.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canWrite && (
          <div className="flex flex-wrap items-end gap-2">
            <Input className="w-52" placeholder="Device name (e.g. Main gate)" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Button size="sm" onClick={register} disabled={!newName.trim()}>
              Register terminal
            </Button>
          </div>
        )}
        {oneTimeSecret && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-800 dark:bg-amber-950/40">
            <p className="font-medium">Configure the device/agent with these — the secret is shown ONCE:</p>
            <p className="mt-1 font-mono">device id: {oneTimeSecret.deviceId}</p>
            <p className="font-mono break-all">secret: {oneTimeSecret.secret}</p>
          </div>
        )}
        {devices.length > 0 && (
          <ul className="space-y-1 text-sm">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5">
                <span className="font-medium">{d.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{d.deviceId}</span>
                <Badge variant={d.enabled ? "default" : "outline"}>{d.enabled ? "enabled" : "disabled"}</Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {d.lastSeenAt ? `last seen ${new Date(d.lastSeenAt).toLocaleString()}` : "never seen"}
                </span>
                {canWrite && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={async () => { await req("DELETE", `/hr/attendance/devices/${d.id}`); void load(); }}>
                    ✕
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="border-t pt-3">
          {canWrite && (
            <div className="flex flex-wrap items-end gap-2">
              <Input className="w-28" placeholder="Device code" value={code} onChange={(e) => setCode(e.target.value)} />
              <select aria-label="Staff" className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">Select staff…</option>
                {staff.map((s) => (
                  <option key={s.userId} value={s.userId}>
                    {s.userName}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="outline" onClick={enroll} disabled={!code.trim() || !who}>
                Map code → staff
              </Button>
            </div>
          )}
          {enrollments.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {enrollments.map((e) => (
                <li key={e.id} className="flex items-center gap-2">
                  <span className="font-mono text-xs">{e.deviceUserId}</span>
                  <span>→ {e.userName ?? "Staff"}</span>
                  {canWrite && (
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-destructive" onClick={async () => { await req("DELETE", `/hr/attendance/enrollments/${e.id}`); void load(); }}>
                      ✕
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}
