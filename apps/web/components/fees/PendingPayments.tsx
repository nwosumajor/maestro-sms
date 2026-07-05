"use client";

import type { PendingPaymentDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money, titleCase } from "@/lib/format";
import { readApiError } from "@/lib/api-error";

export type PendingPayment = Serialized<PendingPaymentDto>;

export function PendingPayments({ payments }: { payments: PendingPayment[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const act = async (id: string, action: "approve" | "reject") => {
    setBusy(id); setMsg(null);
    const res = await fetch(`/api/sms/payments/${id}/${action}`, { method: "POST" });
    setBusy(null);
    if (res.ok) router.refresh();
    else setMsg(res.status === 403 ? "You can't approve a payment you recorded." : await readApiError(res));
  };

  if (payments.length === 0) return null;

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle className="text-base">Payments awaiting your approval</CardTitle>
        <CardDescription>Large payments and all refunds need a second approver (separation of duties).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {payments.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <div className="flex items-center gap-2 text-sm">
              <Badge variant={p.kind === "REFUND" ? "destructive" : "default"}>{titleCase(p.kind)}</Badge>
              <span className="font-medium">{money(p.amountMinor)}</span>
              <span className="text-muted-foreground">{titleCase(p.method)}</span>
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy === p.id} onClick={() => act(p.id, "approve")}>Approve</Button>
              <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => act(p.id, "reject")}>Reject</Button>
            </div>
          </div>
        ))}
        {msg && <p className="text-sm text-destructive">{msg}</p>}
      </CardContent>
    </Card>
  );
}
