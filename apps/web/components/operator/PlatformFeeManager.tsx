"use client";

// Operator: the platform's convenience fee on online fee collection (take-rate).
// Fail-safe zero by default — revenue starts only when the owner sets a fee.
// Mirrors PricingManager: step-up gated PUT, audited server-side.

import type { PlatformFeeConfig } from "@sms/types";
import * as React from "react";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const toMajor = (minor: number | null): string => (minor == null ? "" : String(minor / 100));
const toMinor = (major: string): number | null => {
  if (major.trim() === "") return null;
  const n = Number(major);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

export function PlatformFeeManager({ initial }: { initial: PlatformFeeConfig }) {
  const [flat, setFlat] = React.useState(toMajor(initial.flatMinor));
  const [bp, setBp] = React.useState(String(initial.percentBp));
  const [cap, setCap] = React.useState(toMajor(initial.capMinor));
  const [bearer, setBearer] = React.useState<"PARENT" | "SCHOOL">(initial.bearer);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const save = async () => {
    const flatMinor = toMinor(flat) ?? 0;
    const percentBp = Number(bp) || 0;
    const capMinor = cap.trim() === "" ? null : toMinor(cap);
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("PUT", "operator/platform-fees", { flatMinor, percentBp, capMinor, bearer });
    setBusy(false);
    setMsg(res.ok ? "Saved — applies to every new online fee payment." : await readApiError(res));
  };

  // Live preview on a ₦10,000 payment so the numbers mean something.
  const sample = 1_000_000;
  const preview = Math.max(
    0,
    Math.min(
      (toMinor(flat) ?? 0) + Math.round((sample * (Number(bp) || 0)) / 10000),
      cap.trim() === "" ? Number.MAX_SAFE_INTEGER : (toMinor(cap) ?? 0),
      sample,
    ),
  );
  const fmt = (n: number) => new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" }).format(n / 100);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Fee-collection take-rate</CardTitle>
        <CardDescription>
          The platform&apos;s convenience fee on each ONLINE school-fee payment, taken via the gateway split —
          it never passes through the school&apos;s settlement. Zero = no fee. Schools choose who bears it
          (payer or school); the default bearer applies until they do. Step-up required.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="pf-flat">Flat (₦)</Label>
            <Input id="pf-flat" className="tnum w-24" inputMode="decimal" value={flat} onChange={(e) => setFlat(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-bp">Percent (bp)</Label>
            <Input id="pf-bp" className="tnum w-24" inputMode="numeric" value={bp} onChange={(e) => setBp(e.target.value.replace(/\D/g, ""))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-cap">Cap (₦, blank = none)</Label>
            <Input id="pf-cap" className="tnum w-28" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-bearer">Default bearer</Label>
            <select
              id="pf-bearer"
              value={bearer}
              onChange={(e) => setBearer(e.target.value as "PARENT" | "SCHOOL")}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="PARENT">Payer (parent)</option>
              <option value="SCHOOL">School</option>
            </select>
          </div>
          <Button disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save take-rate"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          100 bp = 1%. Preview: a ₦10,000 payment carries a <span className="tnum font-medium text-foreground">{fmt(preview)}</span> platform fee.
        </p>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
