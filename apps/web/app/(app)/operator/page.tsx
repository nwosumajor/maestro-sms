import type {
  OnboardingRequestDto,
  OperatorBillingAlertDto,
  PlanPriceDto,
  Serialized,
  TenantNameDto,
  TenantPageDto,
} from "@sms/types";
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
import { SchoolStatusToggle } from "@/components/operator/SchoolStatusToggle";
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
  searchParams: { q?: string; plan?: string; billing?: string; page?: string; provision?: string };
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
  const [tenantPage, names, onboarding, pricing, billingAlerts] = await Promise.all([
    apiGet<TenantPage>(`/operator/tenants?${query.toString()}`),
    apiGet<TenantNameDto[]>("/operator/tenant-names"),
    apiGet<Serialized<OnboardingRequestDto>[]>("/operator/onboarding-requests"),
    apiGet<PlanPriceDto[]>("/operator/pricing"),
    apiGet<Serialized<OperatorBillingAlertDto>[]>("/operator/billing-alerts"),
  ]);
  const tenantList = tenantPage?.tenants ?? [];

  // "Approve & provision" deep-link: pre-fill the onboarding form from the
  // request (contact person becomes the school_admin; wish plan/modules applied).
  const provisionReq = searchParams.provision
    ? (onboarding ?? []).find((r) => r.id === searchParams.provision) ?? null
    : null;
  const prefill = provisionReq
    ? {
        requestId: provisionReq.id,
        schoolName: provisionReq.schoolName,
        desiredSlug: provisionReq.desiredSlug,
        contactName: provisionReq.contactName,
        contactEmail: provisionReq.contactEmail,
        desiredPlan: provisionReq.desiredPlan,
        desiredModules: provisionReq.desiredModules,
      }
    : null;

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

        {/* RED ALERT: every school past its paid period, most overdue first. The
            controls live on each tenant card below (restore/extend/comp via the
            subscription editor) — this banner makes sure none sits unnoticed. */}
        {(billingAlerts?.length ?? 0) > 0 && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm font-semibold text-destructive">
              ⚠ {billingAlerts!.length} school{billingAlerts!.length === 1 ? "" : "s"} past their subscription period
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {billingAlerts!.map((a) => (
                <li key={a.schoolId} className="flex flex-wrap items-center gap-2">
                  <Link href={`/operator?billing=PAST_DUE&q=${encodeURIComponent(a.name)}`} className="font-medium hover:underline">
                    {a.name}
                  </Link>
                  <span className="text-muted-foreground">({a.plan})</span>
                  <Badge variant="destructive">{a.daysPastDue} day{a.daysPastDue === 1 ? "" : "s"} past due</Badge>
                  {a.downgraded ? (
                    <Badge variant="destructive">DOWNGRADED to Standard</Badge>
                  ) : (
                    <Badge variant="outline">in grace window</Badge>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Open the school&apos;s card below to extend the period, comp, or restore — paying restores the plan
              automatically.
            </p>
          </div>
        )}

        {/* Keyed on the request id so entering/leaving prefill re-initialises the form. */}
        <Provisioning key={prefill?.requestId ?? "blank"} tenants={names ?? []} prefill={prefill} />

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
                <div className="mb-3">
                  <SchoolStatusToggle schoolId={t.id} status={t.status} />
                </div>
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
