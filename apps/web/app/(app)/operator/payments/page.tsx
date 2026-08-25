// The platform's own revenue ledger — every subscription payment made by every
// school, filtered by PERIOD, with totals split by currency and a CSV export
// for the books. Reached from the /operator quick links.
//
// Read-only by design: reconciling what came in is bookkeeping, and comping a
// plan is a revenue decision that stays behind platform.subscription.manage on
// the tenant screen.

import type { OperatorPaymentPageDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/PageHeader";
import { PaymentFilterBar } from "@/components/operator/PaymentFilterBar";
import { money, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

type PaymentPage = Serialized<OperatorPaymentPageDto>;

/** Same vocabulary the school sees on its own /billing history, so the two
 *  screens cannot describe the same row differently. */
const STATE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  PAID: { label: "Paid", variant: "secondary" },
  PENDING: { label: "Awaiting payment", variant: "default" },
  ABANDONED: { label: "Not completed", variant: "outline" },
  FAILED: { label: "Failed", variant: "destructive" },
};

export default async function OperatorPaymentsPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = await auth();
  const user = session!.user;
  // Gate BEFORE fetching — the read is cross-tenant and audited, so a user who
  // cannot have it should never cause one.
  if (!hasPermission(user.permissions, "platform.revenue.read")) redirect("/dashboard");

  // DEFAULT TO THIS MONTH, not to all time.
  //
  // Two reasons, and they point the same way. A finance desk opening this
  // screen wants the current period, not every payment since the platform
  // began. And a period filter is INDEXED, while an unfiltered total has to
  // read every row that has ever existed — 48ms at ten years of a 5,000-school
  // platform, and linear after that. Clearing the dates still asks the honest
  // unbounded question; it is just no longer what happens by accident.
  const hasExplicitPeriod = Boolean(searchParams.from || searchParams.to);
  const defaultFrom = new Date();
  defaultFrom.setDate(1);
  const effective: Record<string, string | undefined> = {
    ...searchParams,
    ...(hasExplicitPeriod || searchParams.cleared === "1"
      ? {}
      : { from: defaultFrom.toISOString().slice(0, 10) }),
  };

  const query = new URLSearchParams();
  for (const k of ["from", "to", "status", "plan", "currency", "q", "page"]) {
    const v = effective[k];
    if (v) query.set(k, v);
  }
  const data = await apiGet<PaymentPage>(`/operator/payments?${query.toString()}`);

  return (
    <AppShell
      schoolName={user.schoolName}
      userName={user.name ?? "User"}
      active="operator"
      permissions={user.permissions}
    >
      <div className="space-y-6">
        <PageHeader
          title={<>Subscription revenue</>}
          subtitle={<>Every payment made by every school for its plan. Filter by period, then export for the books.</>}
        />

        <PaymentFilterBar
          initial={{
            from: effective.from ?? "",
            to: effective.to ?? "",
            status: searchParams.status ?? "",
            plan: searchParams.plan ?? "",
            currency: searchParams.currency ?? "",
            q: searchParams.q ?? "",
          }}
        />

        {data === null ? (
          /* Not a permission problem — the gate above already handled that. A
             null here means the read failed, and a finance screen that renders
             an empty table when it could not read is worse than one that says so. */
          <Alert variant="info">
            <AlertTitle>Revenue could not be loaded</AlertTitle>
            <AlertDescription>
              The ledger read did not complete. This is not a report that no payments exist — please retry.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {/* TOTALS PER CURRENCY, never one summed number: amountMinor counts
                minor units of its OWN currency, so kobo added to cents is not
                money in any currency. */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.totals.length === 0 ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">No payments in this period</CardTitle>
                    <CardDescription>Widen the dates, or clear the filters.</CardDescription>
                  </CardHeader>
                </Card>
              ) : (
                data.totals.map((t) => (
                  <Card key={t.currency}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">Settled ({t.currency})</CardTitle>
                      <CardDescription>Only money actually received.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-semibold tabular-nums">{money(t.paidMinor, t.currency)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t.paidCount} payment{t.paidCount === 1 ? "" : "s"}
                      </p>
                      <dl className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                        <div className="flex justify-between">
                          <dt>Awaiting payment</dt>
                          <dd className="tabular-nums">
                            {money(t.pendingMinor, t.currency)} · {t.pendingCount}
                          </dd>
                        </div>
                        <div className="flex justify-between">
                          <dt>Failed</dt>
                          <dd className="tabular-nums">{t.failedCount}</dd>
                        </div>
                        <div className="flex justify-between">
                          <dt>Not completed</dt>
                          <dd className="tabular-nums">{t.abandonedCount}</dd>
                        </div>
                      </dl>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>

            {/* THE OTHER HALF OF THE PLATFORM'S INCOME.
                The take-rate on fee collection is stamped onto every settled
                online payment as `payment.platformFeeMinor` — and until now was
                read by nothing at all: no DTO, no endpoint, no screen. The
                person who sets the rate could not see what it earned. Per
                currency for the same reason the subscription totals are: a
                payment inherits its INVOICE's currency, and kobo plus cents is
                not money in any currency. */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.feeRevenue.length === 0 ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">No fee-collection revenue in this period</CardTitle>
                    <CardDescription>
                      The take-rate applies to ONLINE fee payments only, and only where a rate is configured.
                    </CardDescription>
                  </CardHeader>
                </Card>
              ) : (
                data.feeRevenue.map((f) => (
                  <Card key={f.currency}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">Fee take-rate ({f.currency})</CardTitle>
                      <CardDescription>Our cut of school fees collected online.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-semibold tabular-nums">{money(f.feeMinor, f.currency)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        on {money(f.collectedMinor, f.currency)} across {f.payments} payment{f.payments === 1 ? "" : "s"}
                      </p>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>

            {/* WHAT WE ARE OWED AND HAVE NOT BILLED.
                A school buys a seat count and its roll grows mid-period; the
                nightly sweep meters the difference and it is collected at the
                next top-up or renewal. Until then it is earned revenue on no
                revenue screen — the attention queue said WHICH schools had some
                and never how much, and nothing added it up. */}
            {data.seatArrears.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Metered seat growth, not yet billed</CardTitle>
                  <CardDescription>
                    Students carried above the seats each school paid for. Collected automatically at their next
                    renewal, or sooner if they top up. A position as at today — the date filter above does not apply.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-6">
                  {data.seatArrears.map((a) => (
                    <div key={a.currency}>
                      <p className="text-2xl font-semibold tabular-nums">{money(a.amountMinor, a.currency)}</p>
                      <p className="text-xs text-muted-foreground">
                        across {a.schools} school{a.schools === 1 ? "" : "s"} ({a.currency})
                      </p>
                      {a.strandedMinor > 0 && (
                        // No automatic path will ever collect this: every
                        // collection point refuses cross-currency arithmetic,
                        // and these schools now renew in a different currency.
                        // There is no rate here to convert with, so the only
                        // honest thing to do is say so.
                        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                          {money(a.strandedMinor, a.currency)} of it will never be collected automatically —{" "}
                          {a.strandedSchools} school{a.strandedSchools === 1 ? "" : "s"} now renew in another currency
                        </p>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* MESSAGE-CREDIT BUNDLES — the third thing a school pays us for,
                and until now on no screen in the product. Their own list, not
                rows in the subscription table: a bundle has no plan, no seats
                and no period, and empty columns read as missing data rather
                than as inapplicable ones. */}
            {(data.creditRevenue.length > 0 || data.creditPurchases.length > 0) && (
              <Card>
                <CardHeader>
                  <CardTitle>Message credits</CardTitle>
                  <CardDescription>
                    Bundles bought by schools over the selected DATE RANGE — the other filters describe subscription
                    payments and do not apply here. Totals cover the whole range; the list below shows the most recent{" "}
                    {data.creditPurchases.length}.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-6">
                    {data.creditRevenue.map((t) => (
                      <div key={t.currency}>
                        <p className="text-2xl font-semibold tabular-nums">{money(t.amountMinor, t.currency)}</p>
                        <p className="text-xs text-muted-foreground">
                          {t.purchases} purchase{t.purchases === 1 ? "" : "s"} · {t.credits.toLocaleString()} credits (
                          {t.currency})
                        </p>
                      </div>
                    ))}
                    {data.creditRevenue.length === 0 && (
                      <p className="text-sm text-muted-foreground">No priced purchases in this period.</p>
                    )}
                  </div>
                  {data.creditPurchases.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left text-muted-foreground">
                            <th className="py-2 pr-4 font-medium">Date paid</th>
                            <th className="py-2 pr-4 font-medium">School</th>
                            <th className="py-2 pr-4 font-medium">Region</th>
                            <th className="py-2 pr-4 font-medium">Purpose</th>
                            <th className="py-2 pr-4 font-medium">Amount</th>
                            <th className="py-2 pr-4 font-medium">Reference</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.creditPurchases.map((r) => (
                            <tr key={r.id} className="border-b last:border-0">
                              <td className="py-2 pr-4 whitespace-nowrap">{shortDate(r.paidAt)}</td>
                              <td className="py-2 pr-4">{r.schoolName}</td>
                              <td className="py-2 pr-4 whitespace-nowrap">{r.region.country ?? "—"}</td>
                              <td className="py-2 pr-4">
                                {r.credits.toLocaleString()} message credits
                                {r.bundleId ? ` · ${r.bundleId} bundle` : ""}
                              </td>
                              <td className="py-2 pr-4 tabular-nums whitespace-nowrap">
                                {r.amountMinor != null && r.currency ? (
                                  money(r.amountMinor, r.currency)
                                ) : (
                                  // NOT zero. A purchase settled before the
                                  // amount was recorded is unknown, and printing
                                  // 0.00 would understate the books rather than
                                  // admit the gap.
                                  <span className="text-muted-foreground">not recorded</span>
                                )}
                              </td>
                              <td className="py-2 pr-4 font-mono text-xs">{r.reference ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Subscription payments</CardTitle>
                <CardDescription>
                  {data.total} matching payment{data.total === 1 ? "" : "s"} · page {data.page} of{" "}
                  {Math.max(1, Math.ceil(data.total / data.pageSize))}. Subscription totals above cover the whole
                  filter, not just this page; the fee take-rate follows the DATE RANGE only, since plan, status and
                  school search describe subscription payments and mean nothing to it.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data.rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing matches these filters.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          {/* DATE PAID leads, not the checkout date. A book is
                              kept on the day the money arrived: a charge started
                              on the 31st and settled on the 1st belongs to the
                              new month, and this column headed "Date" used to
                              show the 31st. */}
                          <th className="py-2 pr-4 font-medium">Date paid</th>
                          <th className="py-2 pr-4 font-medium">School</th>
                          <th className="py-2 pr-4 font-medium">Region</th>
                          <th className="py-2 pr-4 font-medium">Purpose</th>
                          <th className="py-2 pr-4 font-medium">Seats</th>
                          <th className="py-2 pr-4 font-medium">Amount</th>
                          <th className="py-2 pr-4 font-medium">Status</th>
                          <th className="py-2 pr-4 font-medium">Covers</th>
                          <th className="py-2 pr-4 font-medium">Reference</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((r) => (
                          <tr key={r.id} className="border-b align-top last:border-0">
                            <td className="py-2 pr-4 whitespace-nowrap">
                              {r.paidAt ? (
                                shortDate(r.paidAt)
                              ) : (
                                // NOT a date paid. Saying "—" and showing when
                                // the checkout was started underneath is the
                                // difference between "not yet" and a wrong date.
                                <span className="text-muted-foreground">not paid</span>
                              )}
                              <div className="text-xs text-muted-foreground">started {shortDate(r.createdAt)}</div>
                            </td>
                            <td className="py-2 pr-4">
                              <div>{r.schoolName}</div>
                              {r.initiatedBy && (
                                <div className="text-xs text-muted-foreground">by {r.initiatedBy.name}</div>
                              )}
                            </td>
                            <td className="py-2 pr-4 whitespace-nowrap">
                              <div>{r.region.country ?? "—"}</div>
                              {/* The school's OWN currency, which is not always
                                  the one it was charged in. */}
                              <div className="text-xs text-muted-foreground">books in {r.region.currency}</div>
                            </td>
                            <td className="py-2 pr-4">
                              <div>{r.purpose}</div>
                              <div className="text-xs text-muted-foreground">
                                {r.plan} · {r.billingCycle} · {r.kind}
                              </div>
                            </td>
                            <td className="py-2 pr-4 tabular-nums">{r.seats}</td>
                            <td className="py-2 pr-4 tabular-nums whitespace-nowrap">
                              {money(r.amountMinor, r.currency)}
                              {r.arrearsMinor > 0 && (
                                // Arrears are INCLUDED in the amount, not extra.
                                // Money that was already owed is not new revenue
                                // and a ledger that does not say so overstates
                                // the month it lands in.
                                <div className="text-xs text-muted-foreground">
                                  incl. {money(r.arrearsMinor, r.currency)} arrears
                                </div>
                              )}
                            </td>
                            <td className="py-2 pr-4">
                              <Badge variant={STATE[r.status]?.variant ?? "outline"}>
                                {STATE[r.status]?.label ?? r.status}
                              </Badge>
                            </td>
                            <td className="py-2 pr-4 whitespace-nowrap">
                              {/* THE TENOR: what the money bought, start to end.
                                  Only the end date was shown, so a five-year
                                  purchase and a one-month renewal were
                                  indistinguishable. A charge that buys no time
                                  (a seat top-up, an add-on) says so rather than
                                  borrowing the subscription's window. */}
                              {r.periodStart && r.periodEnd ? (
                                <>
                                  <div>
                                    {shortDate(r.periodStart)} → {shortDate(r.periodEnd)}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {r.tenorDays} days
                                    {r.billingPeriods > 1 ? ` · ${r.billingPeriods} cycles` : ""}
                                  </div>
                                </>
                              ) : (
                                <span className="text-muted-foreground">no period</span>
                              )}
                            </td>
                            <td className="py-2 pr-4 font-mono text-xs">
                              <div>{r.reference}</div>
                              {r.promoCode && <div className="text-muted-foreground">promo {r.promoCode}</div>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
