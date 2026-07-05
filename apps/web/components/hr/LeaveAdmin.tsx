"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { LeaveRequestDto, LeaveTypeDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type Type = Serialized<LeaveTypeDto>;
type Request = Serialized<LeaveRequestDto>;

const VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  PENDING: "secondary", APPROVED: "default", REJECTED: "destructive", CANCELLED: "outline",
};

export function LeaveAdmin({ types, requests, coverage }: { types: Type[]; requests: Request[]; coverage: Request[] }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [days, setDays] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const addType = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !days) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/hr/leave/types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, daysPerYear: parseInt(days, 10) }),
    });
    setBusy(false);
    if (res.ok) { setName(""); setDays(""); router.refresh(); }
    else setMsg(await readApiError(res));
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Leave administration</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={addType} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5"><Label htmlFor="lt-name">New leave type</Label><Input id="lt-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Maternity" /></div>
          <div className="space-y-1.5"><Label htmlFor="lt-days">Days/year</Label><Input id="lt-days" type="number" value={days} onChange={(e) => setDays(e.target.value)} className="w-24" /></div>
          <Button type="submit" disabled={busy}>Add type</Button>
          <span className="text-sm text-muted-foreground">{types.map((t) => `${t.name} (${t.daysPerYear}d)`).join(" · ")}</span>
          {msg && <span className="text-sm text-destructive">{msg}</span>}
        </form>

        <div>
          <p className="mb-2 text-sm font-medium">All leave requests</p>
          {requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-muted-foreground">
                <tr><th className="px-2 py-2 font-medium">Staff</th><th className="px-2 py-2 font-medium">Type</th><th className="px-2 py-2 font-medium">Dates</th><th className="px-2 py-2 font-medium">Days</th><th className="px-2 py-2 font-medium">Status</th></tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-2 py-2">{r.user?.name ?? "—"}</td>
                    <td className="px-2 py-2">{r.leaveTypeName ?? "—"}</td>
                    <td className="px-2 py-2 text-muted-foreground">{r.startDate.slice(0, 10)} → {r.endDate.slice(0, 10)}</td>
                    <td className="px-2 py-2">{r.days}</td>
                    <td className="px-2 py-2"><Badge variant={VARIANT[r.status] ?? "secondary"}>{r.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Approvals happen in the Approvals inbox (head → HR → principal).</p>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Who&apos;s out (next 60 days)</p>
          {coverage.length === 0 ? (
            <p className="text-sm text-muted-foreground">No approved leave in the window.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {coverage.map((r) => (
                <li key={r.id} className="flex justify-between">
                  <span>{r.user?.name ?? "—"} · {r.leaveTypeName ?? ""}</span>
                  <span className="text-muted-foreground">{r.startDate.slice(0, 10)} → {r.endDate.slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
