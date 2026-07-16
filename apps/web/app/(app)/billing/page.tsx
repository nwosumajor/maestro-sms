import type { BillingOverviewDto, ReferralInfoDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { money, shortDate, titleCase } from "@/lib/format";
import { BillingCheckout } from "@/components/billing/BillingCheckout";
import { ReferralPanel } from "@/components/billing/ReferralPanel";

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
  const [data, referral] = await Promise.all([
    apiGet<Overview>("/billing"),
    apiGet<Serialized<ReferralInfoDto>>("/billing/referral"),
  ]);
  const canManage = hasPermission(user.permissions, "billing.manage");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="billing" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Billing &amp; Subscription</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your platform subscription. Pricing is per active student; paying activates your plan automatically.
          </p>
        </div>

        {data === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>You don&apos;t have permission to view billing.</AlertDescription>
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

            <BillingCheckout quotes={data.quotes} activeStudents={data.activeStudents} canManage={canManage} />

            {referral && <ReferralPanel initial={referral} canManage={canManage} />}

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
