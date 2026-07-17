"use client";

// Prepaid SMS/WhatsApp message credits: balance + buy bundles. Each SMS or
// WhatsApp notification delivery consumes one credit; email and in-app are
// always free. Purchases go through the hosted checkout (step-up server-side).

import * as React from "react";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Bundle {
  id: string;
  credits: number;
  priceMinor: number;
}

const naira = (minor: number) => new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" }).format(minor / 100);

export function MessageCreditsCard({
  balance,
  bundles,
  canManage,
}: {
  balance: number;
  bundles: Bundle[];
  canManage: boolean;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const buy = async (bundleId: string) => {
    setBusy(bundleId);
    setMsg(null);
    const res = await sendWithStepUp("POST", "billing/credits/checkout", { bundleId });
    if (res.ok) {
      const data = (await res.json()) as { authorizationUrl: string };
      window.location.href = data.authorizationUrl;
      return;
    }
    setBusy(null);
    setMsg(res.status === 503 ? "Online payments are not configured." : await readApiError(res));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          SMS &amp; WhatsApp credits
          <span className={"tnum rounded-full px-2.5 py-0.5 text-xs font-semibold " + (balance > 0 ? "bg-brand2/15 text-brand2" : "bg-muted text-muted-foreground")}>
            {balance.toLocaleString()} left
          </span>
        </CardTitle>
        <CardDescription>
          Each SMS or WhatsApp notification (fee reminders, absence alerts, receipts) uses one credit —
          reaching parents who don&apos;t check email. In-app and email delivery are always free. When credits
          run out those channels pause; nothing else is affected.
        </CardDescription>
      </CardHeader>
      {canManage && (
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {bundles.map((b) => (
              <Button key={b.id} variant="outline" disabled={busy !== null} onClick={() => buy(b.id)}>
                {busy === b.id ? "Starting…" : `${b.credits.toLocaleString()} credits — ${naira(b.priceMinor)}`}
              </Button>
            ))}
          </div>
          {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        </CardContent>
      )}
    </Card>
  );
}
