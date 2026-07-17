"use client";

// Saved-card auto-renew: the card is captured automatically from a successful
// subscription charge (never typed in here); this card only arms/disarms the
// renewal sweep's charge. Step-up gated server-side.

import * as React from "react";
import { useRouter } from "next/navigation";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function AutoRenewCard({
  autoRenew,
  cardLast4,
  canManage,
}: {
  autoRenew: boolean;
  cardLast4: string | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("PUT", "billing/auto-renew", { enabled: !autoRenew });
    setBusy(false);
    if (res.ok) {
      setMsg(!autoRenew ? "Auto-renew is ON — we'll charge your saved card before the period ends." : "Auto-renew is off.");
      router.refresh();
    } else setMsg(await readApiError(res));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Auto-renew
          {autoRenew ? <Badge variant="secondary">On</Badge> : <Badge variant="outline">Off</Badge>}
        </CardTitle>
        <CardDescription>
          {cardLast4
            ? `Renews your current plan automatically with the saved card (····${cardLast4}) about 2 days before the period ends — at that day's active-student count. A declined charge falls back to the normal renewal reminders; nothing is ever deleted.`
            : "No saved card yet. Pay once by card from this page and it is saved automatically (encrypted) — auto-renew can then be switched on."}
        </CardDescription>
      </CardHeader>
      {canManage && (
        <CardContent className="flex items-center gap-3">
          <Button variant={autoRenew ? "outline" : "default"} disabled={busy || (!autoRenew && !cardLast4)} onClick={toggle}>
            {busy ? "Saving…" : autoRenew ? "Turn off auto-renew" : "Turn on auto-renew"}
          </Button>
          {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        </CardContent>
      )}
    </Card>
  );
}
