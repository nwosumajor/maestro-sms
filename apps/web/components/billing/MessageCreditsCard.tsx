"use client";

// Prepaid SMS/WhatsApp message credits: balance + buy bundles. Each SMS or
// WhatsApp notification delivery consumes one credit; email and in-app are
// always free. Purchases go through the hosted checkout (step-up server-side).

import * as React from "react";
import { useFormat } from "@/components/shell/RegionProvider";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";

interface Bundle {
  id: string;
  credits: number;
  priceMinor: number;
}

// money(), not a hand-rolled en-NG Intl divided by 100 — the same defect the
// API-side sweep removed twelve times. That guard only scanned apps/api, so
// this one survived in the web tier.

interface LedgerRow {
  id: string;
  deltaCredits: number;
  reason: string;
  channel: string | null;
  createdAt: string;
}

/** Plain words, not the enum a school never chose. */
const REASON: Record<string, string> = {
  PURCHASE: "Bundle purchased",
  SEND: "Message sent",
  REFUND: "Refund — message not delivered",
  ADJUST: "Adjustment by support",
};

/** Mirrors MESSAGE_CREDIT_LOW_THRESHOLD on the server, which also warns. */
const LOW = 50;

export function MessageCreditsCard({
  balance,
  bundles,
  canManage,
}: {
  balance: number;
  bundles: Bundle[];
  canManage: boolean;
}) {
  // Dates follow the SCHOOL's calendar, not the browser's.
  const { shortDate } = useFormat();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [showLedger, setShowLedger] = React.useState(false);
  const [ledger, setLedger] = React.useState<LedgerRow[] | null>(null);

  // Fetched only when asked for: this table grows with every message ever sent,
  // and most visits to the billing page never open it.
  React.useEffect(() => {
    if (!showLedger || ledger !== null) return;
    let live = true;
    void (async () => {
      const res = await fetch("/api/sms/notifications/credits/ledger?pageSize=25");
      if (!live) return;
      setLedger(res.ok ? ((await res.json()) as { rows: LedgerRow[] }).rows : []);
    })();
    return () => {
      live = false;
    };
  }, [showLedger, ledger]);
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
          reaching parents who don&apos;t check email. In-app and email delivery are always free.
        </CardDescription>
      </CardHeader>
      {/* Running out is INVISIBLE from inside the school: the app and email keep
          working, so nothing looks broken — only the SMS and WhatsApp copies
          stop. Say exactly what is and is not still reaching parents. */}
      {balance <= 0 && (
        <CardContent className="pt-0">
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-sm font-medium">SMS and WhatsApp alerts have stopped</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Parents are still receiving in-app and email notifications — nothing else is affected. Buy a
              bundle below to restart text and WhatsApp messages.
            </p>
          </div>
        </CardContent>
      )}
      {balance > 0 && balance <= LOW && (
        <CardContent className="pt-0">
          <div className="rounded-md border border-input bg-muted/40 p-3">
            <p className="text-sm">
              Only <span className="font-medium">{balance.toLocaleString()}</span> credits left — SMS and
              WhatsApp stop when they run out. In-app and email keep working.
            </p>
          </div>
        </CardContent>
      )}
      {canManage && (
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {bundles.map((b) => (
              <Button key={b.id} variant="outline" disabled={busy !== null} onClick={() => buy(b.id)}>
                {busy === b.id ? "Starting…" : `${b.credits.toLocaleString()} credits — ${money(b.priceMinor, "NGN")}`}
              </Button>
            ))}
          </div>
          {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        </CardContent>
      )}
      <CardContent className="pt-0">
        {/* WHERE THE CREDITS WENT. The operator could always drill into any
            school's entries; the school could see only a number, so a bursar
            asking "where did 200 credits go?" had nothing to look at. */}
        <button
          type="button"
          onClick={() => setShowLedger((v) => !v)}
          className="text-sm underline underline-offset-2 hover:no-underline"
        >
          {showLedger ? "Hide history" : "Where did my credits go?"}
        </button>
        {showLedger && (
          <div className="mt-3">
            {ledger === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : ledger.length === 0 ? (
              <p className="text-sm text-muted-foreground">No credit activity yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Date</th>
                      <th className="py-2 pr-4 font-medium">What</th>
                      <th className="py-2 pr-4 font-medium">Channel</th>
                      <th className="py-2 pr-4 font-medium text-right">Credits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((e) => (
                      <tr key={e.id} className="border-b last:border-0">
                        <td className="py-2 pr-4 whitespace-nowrap">{shortDate(e.createdAt)}</td>
                        <td className="py-2 pr-4">{REASON[e.reason] ?? e.reason}</td>
                        <td className="py-2 pr-4">{e.channel ?? "—"}</td>
                        <td className={"py-2 pr-4 text-right tabular-nums " + (e.deltaCredits >= 0 ? "text-brand2" : "")}>
                          {e.deltaCredits > 0 ? `+${e.deltaCredits}` : e.deltaCredits}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing the most recent {ledger.length}. A refund appears when a message the network
                  accepted was later reported undelivered — you are not charged for those.
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
