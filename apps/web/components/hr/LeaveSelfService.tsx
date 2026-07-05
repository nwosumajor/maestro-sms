"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { LeaveBalanceDto, LeaveRequestDto, LeaveTypeDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type Type = Serialized<LeaveTypeDto>;
type Balance = Serialized<LeaveBalanceDto>;
type Request = Serialized<LeaveRequestDto>;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  PENDING: "secondary",
  APPROVED: "default",
  REJECTED: "destructive",
  CANCELLED: "outline",
};

function daysBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return ms < 0 ? 0 : Math.round(ms / 86_400_000) + 1;
}

export function LeaveSelfService({
  types,
  balances,
  requests,
}: {
  types: Type[];
  balances: Balance[];
  requests: Request[];
}) {
  const router = useRouter();
  const [leaveTypeId, setLeaveTypeId] = React.useState(types[0]?.id ?? "");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [halfDay, setHalfDay] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const effectiveEnd = halfDay ? startDate : endDate;
  const days = halfDay ? 0.5 : startDate && endDate ? daysBetween(startDate, endDate) : 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leaveTypeId || !startDate || !effectiveEnd || days < 0.5) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/hr/leave/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leaveTypeId, startDate, endDate: effectiveEnd, days, reason: reason || null }),
    });
    setBusy(false);
    if (res.ok) {
      setStartDate("");
      setEndDate("");
      setReason("");
      setMsg("Submitted — routed to your head, then HR, then the principal.");
      router.refresh();
    } else {
      setMsg(await readApiError(res));
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {balances.map((b) => (
          <Card key={b.id}>
            <CardHeader className="pb-2"><CardTitle className="text-sm">{b.leaveTypeName}</CardTitle></CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{b.remainingDays}<span className="text-sm font-normal text-muted-foreground"> / {b.entitledDays} days left</span></p>
              <p className="text-xs text-muted-foreground">{b.usedDays} used in {b.year}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Apply for leave</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="lv-type">Type</Label>
              <select id="lv-type" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5"><Label htmlFor="lv-start">{halfDay ? "Date" : "From"}</Label><Input id="lv-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
            {!halfDay && (
              <div className="space-y-1.5"><Label htmlFor="lv-end">To</Label><Input id="lv-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
            )}
            <label className="flex h-9 items-center gap-1.5 text-sm">
              <input type="checkbox" checked={halfDay} onChange={(e) => setHalfDay(e.target.checked)} /> Half day
            </label>
            <div className="space-y-1.5 flex-1 min-w-40"><Label htmlFor="lv-reason">Reason</Label><Input id="lv-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" /></div>
            <Button type="submit" disabled={busy || days < 1}>{busy ? "Submitting…" : days > 0 ? `Apply (${days}d)` : "Apply"}</Button>
            {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">My leave requests</CardTitle></CardHeader>
        <CardContent className="p-0">
          {requests.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-muted-foreground">
                <tr><th className="px-4 py-2.5 font-medium">Type</th><th className="px-4 py-2.5 font-medium">Dates</th><th className="px-4 py-2.5 font-medium">Days</th><th className="px-4 py-2.5 font-medium">Status</th></tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5">{r.leaveTypeName ?? "—"}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.startDate.slice(0, 10)} → {r.endDate.slice(0, 10)}</td>
                    <td className="px-4 py-2.5">{r.days}</td>
                    <td className="px-4 py-2.5"><Badge variant={STATUS_VARIANT[r.status] ?? "secondary"}>{r.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
