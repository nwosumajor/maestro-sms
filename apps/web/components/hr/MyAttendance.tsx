"use client";

// =============================================================================
// MyAttendance — staff self-service: clock in with the gate code + my history
// =============================================================================
// The 6-digit code comes off the physical display at school (it rotates every
// 30 seconds), so clocking in proves presence. The server derives PRESENT/LATE
// and enforces the window — this form is display-only.
// =============================================================================

import type { Serialized, StaffAttendanceDto } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Mark = Serialized<StaffAttendanceDto>;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  PRESENT: "default",
  LATE: "secondary",
  ABSENT: "destructive",
};

export function MyAttendance({ initial }: { initial: Mark[] }) {
  const [history, setHistory] = React.useState<Mark[]>(initial);
  const [code, setCode] = React.useState("");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const todayMark = history.find((m) => String(m.date).slice(0, 10) === today);

  async function clockIn() {
    if (!code.trim()) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    const res = await fetch(`/api/sms/hr/attendance/clock-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    });
    const raw = await res.text();
    const data = raw ? JSON.parse(raw) : null;
    setBusy(false);
    if (res.ok) {
      setCode("");
      setMsg(`Clocked in — marked ${String((data as Mark).status).toLowerCase()}.`);
      const h = await fetch(`/api/sms/hr/attendance/me`);
      if (h.ok) setHistory((await h.json()) as Mark[]);
    } else {
      const j = data as { message?: string } | null;
      setErr(j?.message ?? `Failed (${res.status}).`);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">My attendance</CardTitle>
        <CardDescription>Enter the code on the school display to clock in for today.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {todayMark ? (
          <p className="text-sm">
            Today: <Badge variant={STATUS_VARIANT[todayMark.status] ?? "secondary"}>{todayMark.status.toLowerCase()}</Badge>
          </p>
        ) : (
          <div className="flex items-end gap-2">
            <Input
              className="w-36 font-mono tracking-widest"
              inputMode="numeric"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button size="sm" onClick={clockIn} disabled={busy || code.trim().length < 6}>
              Clock in
            </Button>
          </div>
        )}

        {history.length > 0 && (
          <ul className="space-y-1 text-sm">
            {history.slice(0, 10).map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <span className="w-28 text-muted-foreground">
                  {new Date(m.date).toLocaleDateString(undefined, { dateStyle: "medium" })}
                </span>
                <Badge variant={STATUS_VARIANT[m.status] ?? "secondary"}>{m.status.toLowerCase()}</Badge>
                {m.clockInAt && (
                  <span className="text-xs text-muted-foreground">
                    {new Date(m.clockInAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {msg && <p className="text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}
        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}
