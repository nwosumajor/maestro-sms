import type { TenantDto, OnboardingRequestDto, PlanPriceDto, Serialized } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { shortDate } from "@/lib/format";
import { SubscriptionManager } from "@/components/operator/SubscriptionManager";
import { Provisioning } from "@/components/operator/Provisioning";
import { OperatorUsers } from "@/components/operator/OperatorUsers";
import { OperatorStudents } from "@/components/operator/OperatorStudents";
import { OnboardingRequests } from "@/components/operator/OnboardingRequests";
import { PricingManager } from "@/components/operator/PricingManager";

export const dynamic = "force-dynamic";

type Tenant = Serialized<TenantDto>;

export default async function OperatorPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "platform.operate")) redirect("/dashboard");
  const [tenants, onboarding, pricing] = await Promise.all([
    apiGet<Tenant[]>("/operator/tenants"),
    apiGet<Serialized<OnboardingRequestDto>[]>("/operator/onboarding-requests"),
    apiGet<PlanPriceDto[]>("/operator/pricing"),
  ]);
  const tenantList = tenants ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="operator" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Operator console</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Provision schools, set each school&apos;s subscription plan and toggle modules — disabled modules
              vanish from their app and return 404 at the API. Impersonation is step-up gated and audited.
            </p>
          </div>
          <Link href="/dashboard"><Button variant="outline">Platform analytics →</Button></Link>
        </div>

        <Provisioning tenants={tenantList.map((t) => ({ id: t.id, name: t.name }))} />

        {pricing && <PricingManager initial={pricing} />}

        <OnboardingRequests requests={onboarding ?? []} />

        <div className="space-y-3">
          {tenantList.map((t) => (
            <Card key={t.id}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-base">{t.name}</CardTitle>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <span className="font-mono">{t.slug}</span> · {t.users} users · since {shortDate(t.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{t.plan}</Badge>
                  <Badge variant="secondary">{t.moduleCount} modules</Badge>
                  <Badge variant={t.status === "ACTIVE" ? "secondary" : "outline"}>{t.status}</Badge>
                  <Badge variant={t.subscriptionStatus === "PAST_DUE" ? "destructive" : "outline"}>
                    billing: {t.subscriptionStatus.toLowerCase()}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <SubscriptionManager schoolId={t.id} plan={t.plan} />
                <OperatorUsers schoolId={t.id} />
                <OperatorStudents schoolId={t.id} />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
