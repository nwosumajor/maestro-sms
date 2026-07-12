"use client";

// =============================================================================
// ExitPanel — resignation/termination with final settlement (staff detail page)
// =============================================================================
// Initiation freezes the settlement (pro-rata + leave payout − loans); a
// DIFFERENT person with hr.salary.approve decides WITH STEP-UP (money). On
// approval the employee is marked exited and the offboarding checklist opens.
// =============================================================================

import type { Serialized, StaffExitDto } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postWithStepUp } from "@/lib/stepup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Exit = Serialized<StaffExitDto>;

const naira = (m: number) => `₦${(m / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

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

export function ExitPanel({
  userId,
  initial,
  canApprove,
}: {
  userId: string;
  initial: Exit[];
  canApprove: boolean;
}) {
  const router = useRouter();
  const mine = initial.filter((e) => e.userId === userId);
  const [exits, setExits] = React.useState<Exit[]>(mine);
  const [type, setType] = React.useState("RESIGNATION");
  const [lastDay, setLastDay] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function refresh() {
    const r = await req("GET", `/hr/exits`);
    if (r.ok) setExits((r.data as Exit[]).filter((e) => e.userId === userId));
    router.refresh();
  }

  async function initiate() {
    if (!lastDay) return;
    setBusy(true);
    setErr(null);
    const r = await req("POST", `/hr/exits`, { userId, type, lastWorkingDay: lastDay, reason: reason || undefined });
    setBusy(false);
    if (r.ok) {
      setReason("");
      void refresh();
    } else setErr(r.error);
  }

  async function decide(id: string, approve: boolean) {
    setErr(null);
    const res = await postWithStepUp(`hr/exits/${id}/decide`, { approve });
    if (res.ok) void refresh();
    else {
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      setErr(j?.message ?? `Failed (${res.status}).`);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Exit management</CardTitle>
        <CardDescription>
          Initiating computes the final settlement (pro-rata pay + leave payout − outstanding loans). Approval
          needs a different person with step-up, marks the staff member exited, and opens offboarding.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!exits.some((e) => e.status === "PENDING" || e.status === "APPROVED") && (
          <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3">
            <div className="space-y-1">
              <Label className="text-xs">Type</Label>
              <select
                aria-label="Exit type"
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                <option value="RESIGNATION">Resignation</option>
                <option value="TERMINATION">Termination</option>
                <option value="RETIREMENT">Retirement</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Last working day</Label>
              <Input className="w-40" type="date" value={lastDay} onChange={(e) => setLastDay(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reason</Label>
              <Input className="w-52" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button size="sm" onClick={initiate} disabled={busy || !lastDay}>
              Initiate exit
            </Button>
          </div>
        )}

        {exits.map((e) => (
          <div key={e.id} className="rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={e.status === "APPROVED" ? "default" : e.status === "REJECTED" ? "destructive" : "secondary"}>
                {e.status.toLowerCase()}
              </Badge>
              <span className="font-medium">{e.type.toLowerCase()}</span>
              <span className="text-muted-foreground">
                last day {new Date(e.lastWorkingDay).toLocaleDateString(undefined, { dateStyle: "medium" })}
              </span>
              {canApprove && e.status === "PENDING" && (
                <span className="ml-auto inline-flex gap-1">
                  <Button size="sm" className="h-7" onClick={() => decide(e.id, true)}>
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" className="h-7" onClick={() => decide(e.id, false)}>
                    Reject
                  </Button>
                </span>
              )}
            </div>
            <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              <span>Pro-rata final month: {naira(e.settlement.proRataMinor)}</span>
              <span>
                Leave payout ({e.settlement.leaveDaysRemaining}d): {naira(e.settlement.leavePayoutMinor)}
              </span>
              <span>Loan recovery: −{naira(e.settlement.loanRecoveredMinor)}</span>
              {e.settlement.loanUnrecoveredMinor > 0 && (
                <span className="text-destructive">Still owed after settlement: {naira(e.settlement.loanUnrecoveredMinor)}</span>
              )}
              <span className="font-medium text-foreground">Net settlement: {naira(e.settlement.netMinor)}</span>
            </div>
          </div>
        ))}
        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}
