"use client";

import { CYCLE_MONTHS, type BillingCycle, type BillingQuoteDto, type Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";
import { postWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";

type Quote = Serialized<BillingQuoteDto>;

const CYCLE_LABEL: Record<string, string> = {
  MONTH: "Monthly",
  TERM: "Per term — 3 months, save 5%",
  YEAR: "Per year — 3 terms (9 months), save 15%",
};

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
  currencyAvailability = [],
}: {
  quotes: Quote[];
  activeStudents: number;
  canManage: boolean;
  /** Which currencies can actually be charged right now, from the server. An
   *  empty list means the page could not establish it — never a reason to
   *  block a purchase that might have worked. */
  currencyAvailability?: Array<{ currency: string; available: boolean; reason: string | null }>;
}) {
  const plans = React.useMemo(() => Array.from(new Set(quotes.map((q) => q.plan))), [quotes]);
  const cycles = React.useMemo(() => Array.from(new Set(quotes.map((q) => q.billingCycle))), [quotes]);
  const [plan, setPlan] = React.useState(plans[0] ?? "STANDARD");
  const [cycle, setCycle] = React.useState(cycles[1] ?? cycles[0] ?? "TERM");
  // Currency choice follows the tier: ₦ (Paystack) or $ (Stripe); ENTERPRISE is
  // USD-only, so its quotes carry only USD and the selector collapses to it.
  const planCurrencies = React.useMemo(
    () => Array.from(new Set(quotes.filter((q) => q.plan === plan).map((q) => q.currency))),
    [quotes, plan],
  );
  const [currency, setCurrency] = React.useState(planCurrencies[0] ?? "NGN");
  const effectiveCurrency = planCurrencies.includes(currency) ? currency : planCurrencies[0] ?? "NGN";
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [promo, setPromo] = React.useState("");

  const selected = quotes.find(
    (q) => q.plan === plan && q.billingCycle === cycle && q.currency === effectiveCurrency,
  );
  // NOT "USD means Stripe" any more: pickCardRail falls back to Paystack for
  // USD while Stripe is switched off, so naming the gateway from the currency
  // told the school the wrong one. The server knows; the page no longer guesses.
  const availability = currencyAvailability.find((c) => c.currency === effectiveCurrency);
  const unavailable = availability != null && !availability.available;
  // Savings vs paying month-by-month for the same coverage: the MONTH quote is
  // undiscounted, so gross = monthly quote × the cycle's months.
  const monthQuote = quotes.find(
    (q) => q.plan === plan && q.billingCycle === "MONTH" && q.currency === effectiveCurrency,
  );
  const savings =
    selected && monthQuote ? monthQuote.priceMinor * CYCLE_MONTHS[cycle as BillingCycle] - selected.priceMinor : 0;

  if (!canManage) return null;

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    // Checkout is step-up gated: the shared sender handles the password re-auth
    // (prompt + retry on a wrong password) transparently.
    const res = await postWithStepUp("billing/checkout/init", {
      plan,
      billingCycle: cycle,
      currency: effectiveCurrency,
      ...(promo.trim() ? { promoCode: promo.trim().toUpperCase() } : {}),
    });
    if (res.ok) {
      const { authorizationUrl } = (await res.json()) as { authorizationUrl: string };
      window.location.href = authorizationUrl;
      return;
    }
    setBusy(false);
    // The server now says WHY (which rail, which currency the account settles).
    // The old text guessed "not configured", which was wrong whenever the real
    // cause was an account not enabled for the currency.
    setMsg(await readApiError(res));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upgrade or renew</CardTitle>
        <CardDescription>
          Per-seat pricing across {activeStudents} active student{activeStudents === 1 ? "" : "s"}. Pay monthly,
          per term (3 months — 5% off) or per year (9 months — 15% off), in naira or US dollars — Enterprise is
          billed in dollars. Your plan activates automatically once the payment is confirmed.
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
            <label className="text-sm font-medium" htmlFor="bill-currency">Currency</label>
            <select
              id="bill-currency"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={effectiveCurrency}
              onChange={(e) => setCurrency(e.target.value as typeof currency)}
              disabled={planCurrencies.length === 1}
            >
              {planCurrencies.map((c) => (
                <option key={c} value={c}>{c === "NGN" ? "₦ Naira" : "$ US Dollar"}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="bill-promo">
              Promo code <span className="font-normal text-muted-foreground">(first payment only)</span>
            </label>
            <input
              id="bill-promo"
              value={promo}
              onChange={(e) => setPromo(e.target.value.toUpperCase())}
              placeholder="Optional"
              className="h-9 w-32 rounded-md border border-input bg-background px-3 font-mono text-sm uppercase"
            />
          </div>
          <div className="space-y-1.5">
            <span className="block text-sm font-medium">Total</span>
            <span className="block h-9 leading-9 text-lg font-semibold tabular-nums">
              {selected ? money(selected.priceMinor, selected.currency) : "—"}
              {savings > 0 && selected && (
                <span className="ml-2 align-middle rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  save {money(savings, selected.currency)}
                </span>
              )}
            </span>
          </div>
          <Button type="submit" disabled={busy || !selected || unavailable}>
            {busy ? "Redirecting…" : "Continue to payment"}
          </Button>
        </form>

        {/* NO DEAD BUTTON. ENTERPRISE is priced in USD, and a gateway account
            not enabled for USD refused the charge with a 403 that reached the
            school as "Payment provider error" — after they had re-authenticated
            and committed to buying. Say it before the click instead. */}
        {unavailable && (
          <p className="mt-3 text-sm text-muted-foreground">
            {effectiveCurrency} payments are not available yet — please contact us and we will arrange this
            plan for you.
          </p>
        )}

        {msg && <p className="mt-3 text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
