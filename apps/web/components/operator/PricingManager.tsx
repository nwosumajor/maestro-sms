"use client";

// super_admin: set the platform's per-tier per-seat pricing. What is saved here
// is EXACTLY what checkout charges and what the public landing page displays
// (one effective-pricing source). PUT is step-up gated + audited server-side.

import type { PlanPriceDto } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function PricingManager({ initial }: { initial: PlanPriceDto[] }) {
  const router = useRouter();
  // Edit in NAIRA for humans; the API stores integer kobo.
  const [naira, setNaira] = React.useState<Record<string, string>>(
    Object.fromEntries(initial.map((r) => [r.plan, String(r.perSeatMonthlyMinor / 100)])),
  );
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const save = async () => {
    const prices: { plan: string; perSeatMonthlyMinor: number }[] = [];
    for (const r of initial) {
      const n = Number(naira[r.plan]);
      if (!Number.isFinite(n) || n <= 0) {
        setMsg(`${r.plan}: enter a positive price in naira.`);
        return;
      }
      prices.push({ plan: r.plan, perSeatMonthlyMinor: Math.round(n * 100) });
    }
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("PUT", "operator/pricing", { prices });
    setBusy(false);
    if (res.ok) {
      setMsg("Pricing saved. Quotes, checkout and the public page now use these prices.");
      router.refresh();
    } else {
      setMsg(await readApiError(res));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Plan pricing</CardTitle>
        <CardDescription>
          Per active student, per month (₦). Applies platform-wide: billing quotes, checkout charges
          and the public pricing page all read these values. Changes require step-up re-auth.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {initial.map((r) => (
            <div key={r.plan} className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <label htmlFor={`price-${r.plan}`} className="text-sm font-medium">
                  {r.plan.charAt(0) + r.plan.slice(1).toLowerCase()}
                </label>
                {r.isDefault ? (
                  <Badge variant="outline" className="text-[0.6rem]">default</Badge>
                ) : (
                  <Badge variant="secondary" className="text-[0.6rem]">custom</Badge>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">₦</span>
                <Input
                  id={`price-${r.plan}`}
                  className="tnum w-28"
                  inputMode="decimal"
                  value={naira[r.plan] ?? ""}
                  onChange={(e) => setNaira((s) => ({ ...s, [r.plan]: e.target.value }))}
                />
                <span className="text-xs text-muted-foreground">/student/mo</span>
              </div>
              <p className="text-xs text-muted-foreground">{r.modulesIncluded} modules</p>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button disabled={busy} onClick={save}>Save pricing</Button>
          {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
