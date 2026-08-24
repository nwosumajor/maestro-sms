"use client";

// super_admin: set what ONE module costs when a school buys it on its own,
// per seat per month. Saved here is exactly what the school's add-on shop
// quotes and what checkout charges — one effective-pricing source, the same
// arrangement as tier pricing. PUT is step-up gated and audited server-side.
//
// THE GUARD RAIL IS SHOWN, NOT HIDDEN. Each row prints what the module costs
// INSIDE the tier that contains it, and flags any price at or below it: an
// add-on cheaper than the upgrade lets schools assemble their own tier, and the
// operator should see that as they type rather than discover it in a month's
// revenue. It does not block the save — pricing is the operator's call, and a
// deliberate loss-leader is a legitimate thing to want.

import {
  CURRENCY_SYMBOL,
  MODULE_CATALOG,
  PLANS,
  PLAN_MODULES,
  PLAN_PRICING,
  type Currency,
  type ModuleAddonPriceDto,
} from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { majorFrom, minorFrom } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const LADDER = [PLANS.STANDARD, PLANS.PREMIUM, PLANS.ULTIMATE, PLANS.ENTERPRISE] as const;
const LABEL = new Map(MODULE_CATALOG.map((c) => [c.key as string, c.label]));

/** The tier that first includes this module, and what the tier charges per
 *  module at that step — the number an add-on must beat. */
function tierBenchmark(module: string): { plan: string; perModuleMinor: number } | null {
  for (let i = 1; i < LADDER.length; i++) {
    const below = new Set<string>(PLAN_MODULES[LADDER[i - 1]]);
    const here = PLAN_MODULES[LADDER[i]] as unknown as string[];
    if (!here.includes(module) || below.has(module)) continue;
    const adds = here.filter((m) => !below.has(m)).length;
    const step =
      PLAN_PRICING[LADDER[i]].perSeatMonthlyMinor - PLAN_PRICING[LADDER[i - 1]].perSeatMonthlyMinor;
    return { plan: LADDER[i], perModuleMinor: Math.round(step / adds) };
  }
  return null;
}

export function AddonPricingManager({ initial }: { initial: ModuleAddonPriceDto[] }) {
  const router = useRouter();
  const currency = (initial[0]?.currency ?? "NGN") as Currency;
  const symbol = CURRENCY_SYMBOL[currency] ?? "";
  // Edited in MAJOR units for humans; the API stores minor units.
  const [major, setMajor] = React.useState<Record<string, string>>(
    Object.fromEntries(initial.map((r) => [r.module, String(majorFrom(r.perSeatMonthlyMinor, currency))])),
  );
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const save = async () => {
    const prices: { module: string; currency: string; perSeatMonthlyMinor: number }[] = [];
    for (const r of initial) {
      const n = Number(major[r.module]);
      if (!Number.isFinite(n) || n < 0) {
        setMsg(`${LABEL.get(r.module) ?? r.module}: enter a price of zero or more.`);
        return;
      }
      prices.push({ module: r.module, currency: r.currency, perSeatMonthlyMinor: minorFrom(n, r.currency) });
    }
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("PUT", "operator/addon-pricing", { prices });
    setBusy(false);
    if (res.ok) {
      setMsg("Saved. Quotes and checkout use the new prices immediately.");
      router.refresh();
    } else {
      setMsg(await readApiError(res));
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Add-on module pricing</CardTitle>
        <CardDescription>
          What one module costs a school that buys it on its own, per student per month, in {currency}. A school is
          charged the remaining part of its current period when it buys, then the full amount at every renewal.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Module</th>
                <th className="py-2 pr-3 font-medium">Per student / month</th>
                <th className="py-2 pr-3 font-medium">Inside its tier</th>
                <th className="py-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {initial.map((r) => {
                const bench = tierBenchmark(r.module);
                const typed = Number(major[r.module]);
                const undercuts =
                  bench !== null && Number.isFinite(typed) && minorFrom(typed, currency) <= bench.perModuleMinor;
                return (
                  <tr key={r.module} className="border-b last:border-0">
                    <td className="py-2 pr-3">{LABEL.get(r.module) ?? r.module}</td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1">
                        <span className="text-muted-foreground">{symbol}</span>
                        <Input
                          aria-label={`${LABEL.get(r.module) ?? r.module} price per student per month`}
                          className="h-8 w-28"
                          type="number"
                          min="0"
                          step="any"
                          value={major[r.module] ?? ""}
                          onChange={(e) => setMajor((m) => ({ ...m, [r.module]: e.target.value }))}
                        />
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {bench ? (
                        <>
                          {symbol}
                          {majorFrom(bench.perModuleMinor, currency).toLocaleString()} in {bench.plan}
                          {undercuts && (
                            <Badge variant="destructive" className="ml-2">
                              cheaper than upgrading
                            </Badge>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2">
                      <Badge variant={r.isDefault ? "outline" : "secondary"}>
                        {r.isDefault ? "default" : "operator-set"}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save add-on prices"}
          </Button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
