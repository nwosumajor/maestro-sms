"use client";

// A school buying ONE module, without changing tier.
//
// Two prices are shown for each, deliberately: what it costs to switch on TODAY
// (prorated to the end of the current period) and what it costs from renewal.
// A bursar comparing options asks both questions, and showing only the first
// produces a surprise on the next invoice.
//
// The upgrade is offered honestly alongside. Where a school is looking at two or
// three add-ons, moving up a tier is usually cheaper — saying so here costs a
// little add-on revenue and earns a subscription that churns less.

import { CURRENCY_SYMBOL, MODULE_CATALOG, type AddonOfferDto, type Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { postWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { postSms } from "@/components/game/play-ui";

import { useFormat } from "@/components/shell/RegionProvider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const LABEL = new Map(MODULE_CATALOG.map((c) => [c.key as string, c.label]));
const BLURB = new Map(MODULE_CATALOG.map((c) => [c.key as string, (c as { description?: string }).description ?? ""]));

export function AddonShop({ offers, canBuy }: { offers: Serialized<AddonOfferDto>[]; canBuy: boolean }) {
  const router = useRouter();
  const { money, shortDate } = useFormat();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  // Only what is actually purchasable. A module already included in the plan is
  // not an offer, and listing it as one invites a school to pay for what it has.
  const available = offers.filter((o) => !o.includedInPlan && !o.alreadyPurchased);
  const owned = offers.filter((o) => o.alreadyPurchased);
  if (available.length === 0 && owned.length === 0) return null;

  const buy = async (module: string) => {
    setBusy(module);
    setMsg(null);
    const res = await postWithStepUp(`billing/addons/${module}/init`, {});
    setBusy(null);
    if (!res.ok) {
      setMsg(await readApiError(res));
      return;
    }
    const body = (await res.json().catch(() => null)) as { authorizationUrl?: string } | null;
    // No URL means there was too little of the period left to be worth a charge
    // and the module was simply switched on — say so rather than doing nothing
    // visible, which reads as a failure.
    if (body?.authorizationUrl) window.location.href = body.authorizationUrl;
    else {
      setMsg("Added to your subscription — there was too little left of this period to charge for. It renews with everything else.");
      router.refresh();
    }
  };

  const cancel = async (module: string) => {
    setBusy(module);
    setMsg(null);
    const res = await postSms(`billing/addons/${module}/cancel`, {});
    setBusy(null);
    if (!res.ok) {
      setMsg(res.error ?? "Could not cancel that module.");
      return;
    }
    setMsg("It will not be billed again. You keep it until the end of the period you have already paid for.");
    router.refresh();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Add a single module</CardTitle>
        <CardDescription>
          Buy one module without changing plan. You pay only for what is left of your current period; from your next
          renewal it is billed with everything else. If you are looking at three or more, moving up a plan is usually
          cheaper — the plan comparison above shows what each would cost you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* WHAT YOU ALREADY PAY FOR, AND HOW TO STOP.
            This was one flat sentence listing the modules, with no way out: a
            school could start a recurring charge in a click and the only exit
            was asking the operator to hand-edit its subscription. */}
        {owned.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">On your subscription</p>
            {owned.map((o) => (
              <div key={o.module} className="flex items-start justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{LABEL.get(o.module) ?? o.module}</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {o.cancelling ? (
                      // Cancelled says WHEN it stops. "Cancelled" on its own is
                      // a worry rather than a decision — the school has paid to
                      // the end of the period and keeps it until then.
                      <>
                        Cancelled · not billed again ·{" "}
                        {o.activeUntil ? <>available until {shortDate(o.activeUntil)}</> : <>ends at your next renewal</>}
                      </>
                    ) : (
                      <>{money(o.perSeatMonthlyMinor, o.currency)} per student / month, billed at each renewal</>
                    )}
                  </p>
                </div>
                {canBuy && !o.cancelling && (
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => cancel(o.module)}>
                    {busy === o.module ? "…" : "Cancel"}
                  </Button>
                )}
                {o.cancelling && <Badge variant="outline">ending</Badge>}
              </div>
            ))}
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {available.map((o) => (
            <div key={o.module} className="flex items-start justify-between gap-3 rounded-md border p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{LABEL.get(o.module) ?? o.module}</div>
                {BLURB.get(o.module) && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{BLURB.get(o.module)}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {money(o.perSeatMonthlyMinor, o.currency)} per student / month
                  {o.priceNowMinor > 0 && <> · {money(o.priceNowMinor, o.currency)} to add now</>}
                </p>
              </div>
              {canBuy ? (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => buy(o.module)}>
                  {busy === o.module ? "…" : o.priceNowMinor > 0 ? "Add" : "Add free"}
                </Button>
              ) : (
                <Badge variant="outline">ask your admin</Badge>
              )}
            </div>
          ))}
        </div>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
