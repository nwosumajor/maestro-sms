"use client";

import {
  CYCLE_MONTHS,
  MAX_BILLING_PERIODS,
  billedMonths,
  currencyLabel,
  periodEndAfter,
  type BillingCycle,
  type BillingQuoteDto,
  type Serialized,
} from "@sms/types";
import * as React from "react";
import { useFormat } from "@/components/shell/RegionProvider";
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
  preferredCurrency = null,
  currentPeriodEnd = null,
}: {
  quotes: Quote[];
  activeStudents: number;
  canManage: boolean;
  /** Where the school's paid access currently runs to, so the "runs until"
   *  preview STACKS the same way settlement does. */
  currentPeriodEnd?: string | null;
  /** Which currencies can actually be charged right now, from the server. An
   *  empty list means the page could not establish it — never a reason to
   *  block a purchase that might have worked. */
  currencyAvailability?: Array<{ currency: string; available: boolean; reason: string | null }>;
  /** The school's OWN currency, when the platform sells in it. */
  preferredCurrency?: string | null;
}) {
  // Dates follow the SCHOOL's calendar, not the browser's.
  const { shortDate } = useFormat();
  const plans = React.useMemo(() => Array.from(new Set(quotes.map((q) => q.plan))), [quotes]);
  const cycles = React.useMemo(() => Array.from(new Set(quotes.map((q) => q.billingCycle))), [quotes]);
  const [plan, setPlan] = React.useState(plans[0] ?? "STANDARD");
  const [cycle, setCycle] = React.useState(cycles[1] ?? cycles[0] ?? "TERM");
  // Every tier sells in both currencies. Which one is DEFAULTED to is decided
  // below from what can actually be charged, not from the tier.
  const planCurrencies = React.useMemo(
    () => Array.from(new Set(quotes.filter((q) => q.plan === plan).map((q) => q.currency))),
    [quotes, plan],
  );
  // Default to a currency that can actually be CHARGED, not the tier's headline
  // one. ENTERPRISE presents in dollars, but the live card rail may not settle
  // USD — defaulting there put the top tier behind a disabled button and sold
  // nothing. Falls back to the tier's own order when nothing is known.
  const [currency, setCurrency] = React.useState<string | null>(null);
  const chargeable = React.useMemo(
    () => planCurrencies.filter((c) => currencyAvailability.find((a) => a.currency === c)?.available !== false),
    [planCurrencies, currencyAvailability],
  );
  const preferred = chargeable[0] ?? planCurrencies[0] ?? "NGN";
  const effectiveCurrency =
    currency && (planCurrencies as string[]).includes(currency) ? (currency as typeof preferred) : preferred;
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [promo, setPromo] = React.useState("");
  // How many cycles to buy at once. The alternative — paying repeatedly — is
  // what raced the subscription's period end, so this is the accurate route to
  // multi-year access as well as the convenient one.
  const [periods, setPeriods] = React.useState(1);

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
    selected && monthQuote
      ? (monthQuote.priceMinor * CYCLE_MONTHS[cycle as BillingCycle] - selected.priceMinor) * periods
      : 0;
  const totalMinor = selected ? selected.priceMinor * periods : 0;
  // THE DATE, not the label. "1 year" does not mean twelve months here — an
  // academic year is 3 terms = 9 BILLED months, holidays not charged — and no
  // amount of wording fixes that. A concrete end date does.
  const months = billedMonths(cycle as BillingCycle, periods);
  const runsUntil = periodEndAfter(
    cycle as BillingCycle,
    periods,
    new Date(),
    currentPeriodEnd ? new Date(currentPeriodEnd) : null,
  );

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
      periods,
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
          per term (3 months — 5% off) or per year (9 months — 15% off). Every plan, including Enterprise, can
          be paid in {planCurrencies.length > 0 ? planCurrencies.join(", ") : "any selling currency"}. Your plan
          activates automatically once the payment is confirmed.
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
              onChange={(e) => setCurrency(e.target.value)}
              disabled={planCurrencies.length === 1}
            >
              {planCurrencies.map((c) => {
                // Say WHY an option cannot be picked rather than hiding it —
                // a school looking for dollars needs to know it is us, not them.
                const off = currencyAvailability.find((a) => a.currency === c)?.available === false;
                return (
                  <option key={c} value={c}>
                    {/* NAMED FROM THE CODE, never from a two-way ternary. This
                        read `c === "NGN" ? naira : US Dollar`, so the day a
                        third selling currency opened, a Ghanaian school's own
                        cedi option was labelled "$ US Dollar". */}
                    {currencyLabel(c)}
                    {off ? " — unavailable" : ""}
                  </option>
                );
              })}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="bill-periods">How many</label>
            <select
              id="bill-periods"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={periods}
              onChange={(e) => setPeriods(Number(e.target.value))}
            >
              {Array.from({ length: MAX_BILLING_PERIODS }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n} x {cycle === "MONTH" ? "month" : cycle === "TERM" ? "term" : "year"}
                  {n === 1 ? "" : "s"}
                </option>
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
              {selected ? money(totalMinor, selected.currency) : "—"}
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
        {/* THE SCHOOL'S OWN CURRENCY, WHEN IT CANNOT BE CHARGED.
            The default already falls back to a chargeable currency, so nobody
            meets a dead button — but falling back SILENTLY is its own problem:
            a Ghanaian school was quoted in naira with nothing saying why, which
            is the confusion that started this. Say which currency is theirs,
            why it cannot be used yet, and what CAN be. */}
        {preferredCurrency &&
          preferredCurrency !== effectiveCurrency &&
          !(chargeable as string[]).includes(preferredCurrency) && (
            <div className="mt-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
              <p>
                <span className="font-medium">{preferredCurrency}</span> is your school&apos;s currency, but
                it cannot be charged yet
                {currencyAvailability.find((a) => a.currency === preferredCurrency)?.reason
                  ? ` — ${currencyAvailability.find((a) => a.currency === preferredCurrency)?.reason}`
                  : "."}
              </p>
              {chargeable.length > 0 ? (
                <p className="mt-1 text-muted-foreground">
                  You can pay in {chargeable.join(" or ")} in the meantime — school fees are unaffected
                  either way, and you can move to {preferredCurrency} at a later renewal once it is
                  enabled.
                </p>
              ) : (
                <p className="mt-1 text-muted-foreground">
                  No currency can be charged right now. Please contact us and we will arrange this plan
                  for you.
                </p>
              )}
            </div>
          )}

        {unavailable && (
          <p className="mt-3 text-sm text-muted-foreground">
            {effectiveCurrency} payments are not available yet — please contact us and we will arrange this
            plan for you.
          </p>
        )}

        {/* WHAT YOU ACTUALLY GET, as a date. Paying more than once to reach the
            same place used to lose periods to a race; one charge for N periods
            cannot race itself, and the date here is computed by the same rule
            settlement uses to write it. */}
        {selected && (
          <p className="mt-3 text-sm">
            Buys <span className="font-medium">{months} billed month{months === 1 ? "" : "s"}</span> — access runs
            until <span className="font-medium">{shortDate(runsUntil)}</span>
            {currentPeriodEnd ? " (added to your current period)" : ""}.
            <span className="block text-xs text-muted-foreground">
              An academic year is 3 terms — 9 billed months. Holiday months are not charged.
            </span>
          </p>
        )}

        {msg && <p className="mt-3 text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
