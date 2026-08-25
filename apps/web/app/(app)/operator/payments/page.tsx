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

            <Card>
              <CardHeader>
                <CardTitle>Payments</CardTitle>
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
                          <th className="py-2 pr-4 font-medium">Date</th>
                          <th className="py-2 pr-4 font-medium">School</th>
                          <th className="py-2 pr-4 font-medium">Plan</th>
                          <th className="py-2 pr-4 font-medium">Cycle</th>
                          <th className="py-2 pr-4 font-medium">Kind</th>
                          <th className="py-2 pr-4 font-medium">Seats</th>
                          <th className="py-2 pr-4 font-medium">Amount</th>
                          <th className="py-2 pr-4 font-medium">Status</th>
                          <th className="py-2 pr-4 font-medium">Period</th>
                          <th className="py-2 pr-4 font-medium">Reference</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((r) => (
                          <tr key={r.id} className="border-b last:border-0">
                            <td className="py-2 pr-4 whitespace-nowrap">{shortDate(r.createdAt)}</td>
                            <td className="py-2 pr-4">{r.schoolName}</td>
                            <td className="py-2 pr-4">{r.plan}</td>
                            <td className="py-2 pr-4">{r.billingCycle}</td>
                            <td className="py-2 pr-4">{r.kind}</td>
                            <td className="py-2 pr-4 tabular-nums">{r.seats}</td>
                            <td className="py-2 pr-4 tabular-nums whitespace-nowrap">
                              {money(r.amountMinor, r.currency)}
                            </td>
                            <td className="py-2 pr-4">
                              <Badge variant={STATE[r.status]?.variant ?? "outline"}>
                                {STATE[r.status]?.label ?? r.status}
                              </Badge>
                            </td>
                            <td className="py-2 pr-4 whitespace-nowrap">
                              {r.periodEnd ? shortDate(r.periodEnd) : "—"}
                            </td>
                            <td className="py-2 pr-4 font-mono text-xs">{r.reference}</td>
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
