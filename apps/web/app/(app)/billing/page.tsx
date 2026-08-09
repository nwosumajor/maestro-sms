import type { BillingOverviewDto, ReferralInfoDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { money, shortDate, titleCase } from "@/lib/format";
import { BillingCheckout } from "@/components/billing/BillingCheckout";
import { ReferralPanel } from "@/components/billing/ReferralPanel";
import { AutoRenewCard } from "@/components/billing/AutoRenewCard";
import { TrueUpCard } from "@/components/billing/TrueUpCard";
import { MessageCreditsCard } from "@/components/billing/MessageCreditsCard";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Overview = Serialized<BillingOverviewDto>;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ACTIVE: "secondary",
  PAST_DUE: "destructive",
  CANCELED: "outline",
};
const PAYMENT_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  PAID: "secondary",
  PENDING: "default",
  FAILED: "destructive",
};

export default async function BillingPage() {
  const session = await auth();
  const user = session!.user;
  // Gate BEFORE fetching. This page had no gate at all: all three reads
  // require billing.read, which 14 of 18 roles lack, so every one of them
  // loaded a billing page that fired three authenticated round-trips and
  // rendered nothing. Redirecting is what the rest of the app does.
  if (!hasPermission(user.permissions, "billing.read")) redirect("/dashboard");

  const [data, referral, credits] = await Promise.all([
    apiGet<Overview>("/billing"),
    apiGet<Serialized<ReferralInfoDto>>("/billing/referral"),
    apiGet<{ balance: number; bundles: { id: string; credits: number; priceMinor: number }[] }>("/billing/credits"),
  ]);
  const canManage = hasPermission(user.permissions, "billing.manage");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="billing" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Billing &amp; Subscription</>} subtitle={<>Your platform subscription. Pricing is per active student; paying activates your plan automatically.</>} />

        {data === null ? (
          /* NOT a permission problem. The gate above already redirected anyone
             without billing.read, so reaching here with null means the read
             itself failed — the API is unreachable, or the subscription record
             is missing. Saying "no access" sent people to their school admin
             for something only support can fix. */
          <Alert variant="info">
            <AlertTitle>Billing details are unavailable</AlertTitle>
            <AlertDescription>
              We could not load your subscription just now. Your plan and access are unaffected. Please refresh,
              and contact support if it persists.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Current plan: {data.subscription.plan}
                  <Badge variant={STATUS_VARIANT[data.subscription.status] ?? "outline"}>
                    {titleCase(data.subscription.status.replace("_", " "))}
                  </Badge>
                  {data.subscription.effectivePlan !== data.subscription.plan && (
                    <Badge variant="destructive">Limited to {data.subscription.effectivePlan}</Badge>
                  )}
                </CardTitle>
                <CardDescription>
                  {data.activeStudents} active student{data.activeStudents === 1 ? "" : "s"}
                  {" · "}
                  {data.subscription.currentPeriodEnd
                    ? `Renews ${shortDate(data.subscription.currentPeriodEnd)}`
                    : "No active paid period"}
                  {data.subscription.priceMinor != null &&
                    ` · Last charged ${money(data.subscription.priceMinor, data.subscription.currency ?? "NGN")}`}
                </CardDescription>
              </CardHeader>
              {data.subscription.status === "PAST_DUE" && (
                <CardContent>
                  <Alert variant="info">
                    <AlertTitle>Payment overdue</AlertTitle>
                    <AlertDescription>
                      Renew to restore your full plan. After the grace period the school is limited to the Standard plan
                      until payment is received.
                    </AlertDescription>
                  </Alert>
                </CardContent>
              )}
            </Card>

            {(data.trueUp || data.seatArrearsMinor > 0) && (
              <TrueUpCard
                trueUp={data.trueUp}
                seatArrearsMinor={data.seatArrearsMinor}
                currency={data.subscription.currency ?? "NGN"}
                canManage={canManage}
              />
            )}

            <BillingCheckout
              quotes={data.quotes}
              activeStudents={data.activeStudents}
              canManage={canManage}
              currencyAvailability={data.currencyAvailability}
            />

            {data.planChangeCreditMinor > 0 && (
              <p className="text-xs text-muted-foreground">
                Switching plans mid-period? Your unused time is worth about{" "}
                <span className="tnum font-medium text-foreground">
                  {/* was a hand-rolled en-NG Intl formatter dividing by 100 —
                      the one line on this page that skipped the shared helper,
                      so it printed a different format from every figure beside
                      it and would be 100x wrong in a zero-decimal currency. */}
                  {money(data.planChangeCreditMinor, data.subscription.currency ?? "NGN")}
                </span>{" "}
                — it is deducted automatically from the plan-change charge, and the new plan runs a full cycle
                from the day you pay.
              </p>
            )}

            <AutoRenewCard autoRenew={data.autoRenew} cardLast4={data.cardLast4} canManage={canManage} />

            {/* A null read is "could not ask", not "you have none" — rendering
                nothing made a failed fetch look like an empty balance and an
                absent referral programme. */}
            {credits ? (
              <MessageCreditsCard balance={credits.balance} bundles={[...credits.bundles]} canManage={canManage} />
            ) : (
              <p className="text-xs text-muted-foreground">Message credits could not be loaded just now.</p>
            )}

            {referral ? (
              <ReferralPanel initial={referral} canManage={canManage} />
            ) : (
              <p className="text-xs text-muted-foreground">Your referral details could not be loaded just now.</p>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Payment history</CardTitle>
                <CardDescription>Your platform subscription payments.</CardDescription>
              </CardHeader>
              <CardContent>
                {data.payments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No payments yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="py-2 pr-4 font-medium">Date</th>
                          <th className="py-2 pr-4 font-medium">Plan</th>
                          <th className="py-2 pr-4 font-medium">Cycle</th>
                          <th className="py-2 pr-4 font-medium">Seats</th>
                          <th className="py-2 pr-4 font-medium">Amount</th>
                          <th className="py-2 pr-4 font-medium">Status</th>
                          <th className="py-2 pr-4 font-medium">Period end</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.payments.map((pmt) => (
                          <tr key={pmt.id} className="border-b last:border-0">
                            <td className="py-2 pr-4">{shortDate(pmt.createdAt)}</td>
                            <td className="py-2 pr-4">{pmt.plan}</td>
                            <td className="py-2 pr-4">{titleCase(pmt.billingCycle)}</td>
                            <td className="py-2 pr-4 tabular-nums">{pmt.seats}</td>
                            <td className="py-2 pr-4 tabular-nums">{money(pmt.amountMinor, pmt.currency)}</td>
                            <td className="py-2 pr-4">
                              <Badge variant={PAYMENT_VARIANT[pmt.status] ?? "outline"}>{titleCase(pmt.status)}</Badge>
                            </td>
                            <td className="py-2 pr-4">{pmt.periodEnd ? shortDate(pmt.periodEnd) : "—"}</td>
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
