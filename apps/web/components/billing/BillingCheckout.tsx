"use client";

import type { BillingQuoteDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";

type Quote = Serialized<BillingQuoteDto>;

const CYCLE_LABEL: Record<string, string> = { MONTH: "Monthly", TERM: "Per term", YEAR: "Annual" };

/**
 * Client island: pick a tier + billing cycle and start a hosted Paystack
 * checkout. Checkout is step-up gated server-side — on a 403 we mint a step-up
 * token (confirm password) and retry once, mirroring the medical-edit flow. On
 * success the API returns an authorization URL we redirect to.
 */
export function BillingCheckout({
  quotes,
  activeStudents,
  canManage,
}: {
  quotes: Quote[];
  activeStudents: number;
  canManage: boolean;
}) {
  const plans = React.useMemo(() => Array.from(new Set(quotes.map((q) => q.plan))), [quotes]);
  const cycles = React.useMemo(() => Array.from(new Set(quotes.map((q) => q.billingCycle))), [quotes]);
  const [plan, setPlan] = React.useState(plans[0] ?? "STANDARD");
  const [cycle, setCycle] = React.useState(cycles[1] ?? cycles[0] ?? "TERM");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const selected = quotes.find((q) => q.plan === plan && q.billingCycle === cycle);

  if (!canManage) return null;

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const body = JSON.stringify({ plan, billingCycle: cycle });
    let res = await fetch("/api/sms/billing/checkout/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    // Checkout requires a fresh step-up re-auth: on 403, confirm password, mint a
    // step-up token, and retry once with it.
    if (res.status === 403) {
      const pw = window.prompt("Confirm your password to start the payment:");
      if (pw) {
        const su = await fetch("/api/sms/security/stepup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pw }),
        });
        if (su.ok) {
          const { token } = (await su.json()) as { token: string };
          res = await fetch("/api/sms/billing/checkout/init", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-stepup": token },
            body,
          });
        }
      }
    }
    if (res.ok) {
      const { authorizationUrl } = (await res.json()) as { authorizationUrl: string };
      window.location.href = authorizationUrl;
      return;
    }
    setBusy(false);
    setMsg(
      res.status === 503
        ? "Online payments are not configured yet. Contact the platform operator."
        : res.status === 403
          ? "Step-up confirmation required."
          : `Checkout failed (${res.status}).`,
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upgrade or renew</CardTitle>
        <CardDescription>
          Per-seat pricing across {activeStudents} active student{activeStudents === 1 ? "" : "s"}. You pay securely via
          Paystack; your plan activates automatically once the payment is confirmed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={pay} className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="bill-plan">Plan</label>
            <select
              id="bill-plan"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={plan}
              onChange={(e) => setPlan(e.target.value as typeof plan)}
            >
              {plans.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="bill-cycle">Billing cycle</label>
            <select
              id="bill-cycle"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={cycle}
              onChange={(e) => setCycle(e.target.value as typeof cycle)}
            >
              {cycles.map((c) => (
                <option key={c} value={c}>{CYCLE_LABEL[c] ?? c}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <span className="block text-sm font-medium">Total</span>
            <span className="block h-9 leading-9 text-lg font-semibold tabular-nums">
              {selected ? money(selected.priceMinor) : "—"}
            </span>
          </div>
          <Button type="submit" disabled={busy || !selected}>
            {busy ? "Redirecting…" : "Pay with Paystack"}
          </Button>
        </form>
        {msg && <p className="mt-3 text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
