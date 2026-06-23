"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dateTime, titleCase } from "@/lib/format";

export interface Grant {
  id: string;
  userId: string;
  permission: string;
  reason: string;
  status: string;
  breakGlass: boolean;
  requestedById: string;
  expiresAt: string | null;
  createdAt: string;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  PENDING: "default",
  ACTIVE: "secondary",
  EXPIRED: "outline",
  REVOKED: "destructive",
};

export function ElevationPanel({
  grants,
  userId,
  canApprove,
}: {
  grants: Grant[];
  userId: string;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [permission, setPermission] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [minutes, setMinutes] = React.useState(60);
  const [breakGlass, setBreakGlass] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const request = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!permission || !reason) return;
    setBusy(true); setMsg(null);
    const res = await fetch("/api/sms/security/elevation/request", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permission, reason, minutes, breakGlass }),
    });
    setBusy(false);
    if (res.ok) { setPermission(""); setReason(""); setMsg(breakGlass ? "Break-glass granted (flagged)." : "Requested — awaiting approval."); router.refresh(); }
    else setMsg(`Failed (${res.status}).`);
  };

  const act = async (id: string, action: "approve" | "revoke") => {
    const res = await fetch(`/api/sms/security/elevation/${id}/${action}`, { method: "POST" });
    if (res.ok) router.refresh();
    else setMsg(res.status === 403 ? "You can't approve your own request." : `Failed (${res.status}).`);
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Request elevation</CardTitle>
          <CardDescription>
            Temporarily grant yourself a permission you don't normally hold. A
            different person must approve — unless you break glass (emergency,
            flagged + alerted).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={request} className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5"><Label htmlFor="e-perm">Permission</Label><Input id="e-perm" value={permission} onChange={(e) => setPermission(e.target.value)} placeholder="e.g. fee.manage" className="w-44" /></div>
            <div className="flex-1 space-y-1.5"><Label htmlFor="e-reason">Reason</Label><Input id="e-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why you need it" /></div>
            <div className="space-y-1.5"><Label htmlFor="e-min">Minutes</Label><Input id="e-min" type="number" min={1} max={480} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="w-24" /></div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" checked={breakGlass} onChange={(e) => setBreakGlass(e.target.checked)} />
              Break-glass
            </label>
            <Button type="submit" disabled={busy} variant={breakGlass ? "destructive" : "default"}>
              {busy ? "…" : breakGlass ? "Break glass" : "Request"}
            </Button>
          </form>
          {msg && <p className="mt-2 text-sm text-muted-foreground">{msg}</p>}
        </CardContent>
      </Card>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Grants</h2>
        {grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">No elevation grants.</p>
        ) : (
          grants.map((g) => (
            <Card key={g.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-medium">{g.permission}</code>
                    <Badge variant={STATUS_VARIANT[g.status] ?? "outline"}>{titleCase(g.status)}</Badge>
                    {g.breakGlass && <Badge variant="destructive">Break-glass</Badge>}
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">{g.reason}</p>
                  <p className="text-xs text-muted-foreground">
                    requested {dateTime(g.createdAt)}{g.expiresAt ? ` · expires ${dateTime(g.expiresAt)}` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  {canApprove && g.status === "PENDING" && g.requestedById !== userId && (
                    <Button size="sm" onClick={() => act(g.id, "approve")}>Approve</Button>
                  )}
                  {canApprove && (g.status === "ACTIVE" || g.status === "PENDING") && (
                    <Button size="sm" variant="ghost" onClick={() => act(g.id, "revoke")}>Revoke</Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
