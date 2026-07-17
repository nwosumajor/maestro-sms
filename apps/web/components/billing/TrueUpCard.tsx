"use client";

// Seat true-up: enrollment grew past the billed seat count mid-period — pay the
// difference for the time left. Quote comes from the overview (server-computed
// with the same rules checkout charges). Step-up gated server-side.

import * as React from "react";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function TrueUpCard({
  trueUp,
  seatArrearsMinor,
  currency,
  canManage,
}: {
  trueUp: { extraSeats: number; amountMinor: number } | null;
  seatArrearsMinor: number;
  currency: string;
  canManage: boolean;
}) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const money = (minor: number) => new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(minor / 100);
  const totalMinor = (trueUp?.amountMinor ?? 0) + seatArrearsMinor;
  const fmt = money(totalMinor);

  const pay = async () => {
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("POST", "billing/true-up/init", {});
    if (res.ok) {
      const data = (await res.json()) as { authorizationUrl: string };
      window.location.href = data.authorizationUrl;
      return;
    }
    setBusy(false);
    setMsg(await readApiError(res));
  };

  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="text-base">Seat top-up due</CardTitle>
        <CardDescription>
          {trueUp ? (
            <>
              Your school has grown by <span className="font-semibold text-foreground">{trueUp.extraSeats}</span>{" "}
              student{trueUp.extraSeats === 1 ? "" : "s"} since your last charge.
            </>
          ) : (
            <>Your school ran more students than it was billed for this period.</>
          )}{" "}
          {seatArrearsMinor > 0 && (
            <>
              Usage already metered: <span className="font-semibold text-foreground">{money(seatArrearsMinor)}</span>
              {trueUp ? <> · Cover for the rest of the period: <span className="font-semibold text-foreground">{money(trueUp.amountMinor)}</span></> : null}
              {". "}
            </>
          )}
          Settling now clears it; otherwise it is added automatically to your next renewal charge. Your
          renewal date doesn&apos;t change.
        </CardDescription>
      </CardHeader>
      {canManage && (
        <CardContent className="flex items-center gap-3">
          <Button onClick={pay} disabled={busy}>
            {busy ? "Starting…" : `Settle now (${fmt})`}
          </Button>
          {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        </CardContent>
      )}
    </Card>
  );
}
