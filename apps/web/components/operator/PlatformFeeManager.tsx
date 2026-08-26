"use client";

// Operator: the platform's convenience fee on online fee collection (take-rate).
// Fail-safe zero by default — revenue starts only when the owner sets a fee.
// Mirrors PricingManager: step-up gated PUT, audited server-side.
//
// PER CURRENCY. The take-rate rides the Paystack split and Paystack settles
// NGN/GHS/ZAR/KES/USD, and `flatMinor`/`capMinor` are minor units OF THE CHOSEN
// CURRENCY. This card used to be naira-only — `/100`, `en-NG`, a "Flat (₦)"
// label — while the one config it edited was applied to every currency, so a
// NGN 2,000 cap read as a GHS 2,000 cap and never bound. A currency with no row
// charges NOTHING until the owner prices it.

import { PAYSTACK_CURRENCIES, formatMoney, minorUnits, type PlatformFeeConfig } from "@sms/types";
import * as React from "react";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Scaled BY THE CURRENCY, never by 100 — the CFA franc has no minor unit and a
// hard-coded 100 is 100x wrong there.
const toMajor = (minor: number | null, currency: string): string =>
  minor == null ? "" : String(minor / minorUnits(currency));
const toMinor = (major: string, currency: string): number | null => {
  if (major.trim() === "") return null;
  const n = Number(major);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * minorUnits(currency)) : null;
};

export function PlatformFeeManager({ initial }: { initial: PlatformFeeConfig }) {
  const [currency, setCurrency] = React.useState<string>("NGN");
  const [flat, setFlat] = React.useState(toMajor(initial.flatMinor, "NGN"));
  const [bp, setBp] = React.useState(String(initial.percentBp));
  const [cap, setCap] = React.useState(toMajor(initial.capMinor, "NGN"));
  const [bearer, setBearer] = React.useState<"PARENT" | "SCHOOL">(initial.bearer);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  // Switching currency loads THAT currency's row. Carrying the previous one's
  // figures across is how a naira cap ends up saved as a cedi one.
  const pick = async (next: string) => {
    setCurrency(next);
    setMsg(null);
    try {
      const res = await fetch(`/api/sms/operator/platform-fees?currency=${encodeURIComponent(next)}`);
      if (!res.ok) throw new Error(String(res.status));
      const cfg = (await res.json()) as PlatformFeeConfig;
      setFlat(toMajor(cfg.flatMinor, next));
      setBp(String(cfg.percentBp));
      setCap(toMajor(cfg.capMinor, next));
      setBearer(cfg.bearer);
    } catch {
      setMsg("Could not load the take-rate for that currency.");
    }
  };

  const save = async () => {
    const flatMinor = toMinor(flat, currency) ?? 0;
    const percentBp = Number(bp) || 0;
    const capMinor = cap.trim() === "" ? null : toMinor(cap, currency);
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("PUT", "operator/platform-fees", { currency, flatMinor, percentBp, capMinor, bearer });
    setBusy(false);
    setMsg(
      res.ok
        ? `Saved — applies to every new online fee payment billed in ${currency}.`
        : await readApiError(res),
    );
  };

  // Live preview on a 10,000-major payment IN THE CHOSEN CURRENCY, so the
  // numbers mean something for the market being priced.
  const sample = 10_000 * minorUnits(currency);
  const preview = Math.max(
    0,
    Math.min(
      (toMinor(flat, currency) ?? 0) + Math.round((sample * (Number(bp) || 0)) / 10000),
      cap.trim() === "" ? Number.MAX_SAFE_INTEGER : (toMinor(cap, currency) ?? 0),
      sample,
    ),
  );
  const fmt = (n: number) => formatMoney(n, currency);

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
            <Label htmlFor="pf-currency">Currency</Label>
            <select
              id="pf-currency"
              value={currency}
              onChange={(e) => void pick(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {PAYSTACK_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-flat">Flat ({currency})</Label>
            <Input id="pf-flat" className="tnum w-24" inputMode="decimal" value={flat} onChange={(e) => setFlat(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-bp">Percent (bp)</Label>
            <Input id="pf-bp" className="tnum w-24" inputMode="numeric" value={bp} onChange={(e) => setBp(e.target.value.replace(/\D/g, ""))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-cap">Cap ({currency}, blank = none)</Label>
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
          100 bp = 1%. Preview: a {fmt(sample)} payment carries a{" "}
          <span className="tnum font-medium text-foreground">{fmt(preview)}</span> platform fee. A currency
          left at zero charges nothing — schools billing in it collect fees with no platform cut.
        </p>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
