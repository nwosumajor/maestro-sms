import type { TenantPageDto, TenantNameDto, OnboardingRequestDto, PlanPriceDto, Serialized } from "@sms/types";
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
import { StudentDataExport } from "@/components/operator/StudentDataExport";
import { ScholarshipAdmin } from "@/components/operator/ScholarshipAdmin";
import { OnboardingRequests } from "@/components/operator/OnboardingRequests";
import { PricingManager } from "@/components/operator/PricingManager";
import { TenantFilterBar } from "@/components/operator/TenantFilterBar";

export const dynamic = "force-dynamic";

type TenantPage = Serialized<TenantPageDto>;

export default async function OperatorPage({
  searchParams,
}: {
  searchParams: { q?: string; plan?: string; billing?: string; page?: string };
}) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "platform.operate")) redirect("/dashboard");
  const q = searchParams.q ?? "";
  const plan = searchParams.plan ?? "";
  const billing = searchParams.billing ?? "";
  const pageNum = Math.max(1, Number(searchParams.page) || 1);
  const query = new URLSearchParams();
  if (q) query.set("q", q);
  if (plan) query.set("plan", plan);
  if (billing) query.set("billing", billing);
  query.set("page", String(pageNum));
  const [tenantPage, names, onboarding, pricing] = await Promise.all([
    apiGet<TenantPage>(`/operator/tenants?${query.toString()}`),
    apiGet<TenantNameDto[]>("/operator/tenant-names"),
    apiGet<Serialized<OnboardingRequestDto>[]>("/operator/onboarding-requests"),
    apiGet<PlanPriceDto[]>("/operator/pricing"),
  ]);
  const tenantList = tenantPage?.tenants ?? [];

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

        <Provisioning tenants={names ?? []} />

        <ScholarshipAdmin />

        {pricing && <PricingManager initial={pricing} />}

        <OnboardingRequests requests={onboarding ?? []} />

        <TenantFilterBar
          q={q}
          plan={plan}
          billing={billing}
          page={tenantPage?.page ?? pageNum}
          pageSize={tenantPage?.pageSize ?? 10}
          total={tenantPage?.total ?? tenantList.length}
        />

        <div className="space-y-3">
          {tenantList.length === 0 && (
            <p className="rounded-md border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              No schools match this search/filter.
            </p>
          )}
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
                <StudentDataExport schoolId={t.id} schoolName={t.name} />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
