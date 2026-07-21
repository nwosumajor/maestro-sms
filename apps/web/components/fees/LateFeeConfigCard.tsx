"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { LateFeeConfigDto } from "@sms/types";
import { sendWithStepUp } from "@/lib/stepup";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Per-school automatic late-fee policy (money-policy write: step-up gated,
// same as settlement). 0 flat fee = disabled.
export function LateFeeConfigCard({ initial }: { initial: LateFeeConfigDto }) {
  const router = useRouter();
  const [flat, setFlat] = React.useState(String(initial.lateFeeFlatMinor / 100));
  const [grace, setGrace] = React.useState(String(initial.lateFeeGraceDays));
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("PUT", "fees/late-fee-config", {
      lateFeeFlatMinor: Math.round(Number(flat) * 100),
      lateFeeGraceDays: Number(grace),
    });
    setBusy(false);
    if (res.ok) {
      setMsg("Saved.");
      router.refresh();
    } else {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      setMsg(body?.message ?? "Failed.");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Automatic late fee</CardTitle>
        <CardDescription>
          Added once to any invoice still unpaid past its due date + grace period; guardians are notified. Set the
          amount to 0 to disable.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-muted-foreground">Fee (₦)</label>
        <input
          type="number"
          min="0"
          step="0.01"
          className="w-32 rounded-md border bg-background p-1.5 text-sm"
          value={flat}
          onChange={(e) => setFlat(e.target.value)}
        />
        <label className="text-sm text-muted-foreground">Grace (days)</label>
        <input
          type="number"
          min="0"
          max="90"
          className="w-24 rounded-md border bg-background p-1.5 text-sm"
          value={grace}
          onChange={(e) => setGrace(e.target.value)}
        />
        <Button size="sm" disabled={busy} onClick={save}>
          Save
        </Button>
        {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
      </CardContent>
    </Card>
  );
}
