"use client";

// super_admin: set the platform's per-(tier, currency) per-seat pricing. What is
// saved here is EXACTLY what checkout charges and what the public landing page
// displays (one effective-pricing source). NGN sells via Paystack, USD via
// Stripe; ENTERPRISE is USD-ONLY (the API refuses an NGN row for it, so it
// simply has no ₦ input). PUT is step-up gated + audited server-side.

import { CURRENCY_SYMBOL, type Currency, type PlanPriceDto } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const key = (r: { plan: string; currency: string }) => `${r.plan}:${r.currency}`;

export function PricingManager({ initial }: { initial: PlanPriceDto[] }) {
  const router = useRouter();
  // Edit in MAJOR units (naira / dollars) for humans; the API stores minor units.
  const [major, setMajor] = React.useState<Record<string, string>>(
    Object.fromEntries(initial.map((r) => [key(r), String(r.perSeatMonthlyMinor / 100)])),
  );
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const currencies: Currency[] = ["NGN", "USD"];

  const save = async () => {
    const prices: { plan: string; perSeatMonthlyMinor: number; currency: string }[] = [];
    for (const r of initial) {
      const n = Number(major[key(r)]);
      if (!Number.isFinite(n) || n <= 0) {
        setMsg(`${r.plan} (${r.currency}): enter a positive price.`);
        return;
      }
      prices.push({ plan: r.plan, currency: r.currency, perSeatMonthlyMinor: Math.round(n * 100) });
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
          Per active student, per month. Naira prices charge via Paystack, dollar prices via Stripe —
          Enterprise is sold in dollars only (international schools). Applies platform-wide: billing
          quotes, checkout charges and the public pricing page all read these values. Step-up required.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {currencies.map((currency) => {
          const rows = initial.filter((r) => r.currency === currency);
          if (rows.length === 0) return null;
          return (
            <div key={currency}>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {currency === "NGN" ? "Naira (Paystack)" : "US Dollar (Stripe)"}
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {rows.map((r) => (
                  <div key={key(r)} className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <label htmlFor={`price-${key(r)}`} className="text-sm font-medium">
                        {r.plan.charAt(0) + r.plan.slice(1).toLowerCase()}
                      </label>
                      {r.isDefault ? (
                        <Badge variant="outline" className="text-[0.6rem]">default</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[0.6rem]">custom</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">{CURRENCY_SYMBOL[r.currency]}</span>
                      <Input
                        id={`price-${key(r)}`}
                        className="tnum w-28"
                        inputMode="decimal"
                        value={major[key(r)] ?? ""}
                        onChange={(e) => setMajor((s) => ({ ...s, [key(r)]: e.target.value }))}
                      />
                      <span className="text-xs text-muted-foreground">/student/mo</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{r.modulesIncluded} modules</p>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        <div className="flex items-center gap-3">
          <Button disabled={busy} onClick={save}>Save pricing</Button>
          {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
