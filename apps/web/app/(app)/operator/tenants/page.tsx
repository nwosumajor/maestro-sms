// Tenant registry — the platform owner's per-school MANAGEMENT list: search /
// filter / paginate, then act on each school (status, subscription, grace,
// users, students, data export). Moved off the /operator hub to its own page,
// reachable from the sidebar. Read-only school info (owner/contacts/billing)
// lives on the sibling /operator/schools directory.

import type { Serialized, TenantPageDto } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { shortDate } from "@/lib/format";
import { SubscriptionManager } from "@/components/operator/SubscriptionManager";
import { SchoolStatusToggle } from "@/components/operator/SchoolStatusToggle";
import { OperatorUsers } from "@/components/operator/OperatorUsers";
import { OperatorStudents } from "@/components/operator/OperatorStudents";
import { StudentDataExport } from "@/components/operator/StudentDataExport";
import { GraceEditor } from "@/components/operator/GraceEditor";
import { TenantFilterBar } from "@/components/operator/TenantFilterBar";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type TenantPage = Serialized<TenantPageDto>;

export default async function OperatorTenantsPage({
  searchParams,
}: {
  searchParams: { q?: string; plan?: string; billing?: string; page?: string };
}) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "platform.tenants.read")) redirect("/dashboard");

  const canSetStatus = hasPermission(user.permissions, "platform.tenants.status");
  const canManageSubscription = hasPermission(user.permissions, "platform.subscription.manage");
  const canReadUsers = hasPermission(user.permissions, "platform.user.read");
  const canCredentials = hasPermission(user.permissions, "platform.user.credentials");
  const canImpersonate = hasPermission(user.permissions, "platform.impersonate");
  const canManageGrace = hasPermission(user.permissions, "platform.grace.manage");
  const canReadStudents = hasPermission(user.permissions, "platform.student.read");

  const q = searchParams.q ?? "";
  const plan = searchParams.plan ?? "";
  const billing = searchParams.billing ?? "";
  const pageNum = Math.max(1, Number(searchParams.page) || 1);
  const query = new URLSearchParams();
  if (q) query.set("q", q);
  if (plan) query.set("plan", plan);
  if (billing) query.set("billing", billing);
  query.set("page", String(pageNum));

  const tenantPage = await apiGet<TenantPage>(`/operator/tenants?${query.toString()}`);
  const tenantList = tenantPage?.tenants ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="operatortenants" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <PageHeader title={<>Tenant registry</>} subtitle={<>Every onboarded school — set its subscription and grace, toggle its status, manage its accounts,
              read its students, or export its data. Impersonation is step-up gated and audited.</>} />
          <div className="flex items-center gap-3 text-sm">
            <Link href="/operator/schools" className="font-medium text-primary hover:underline">
              School directory (owners, contacts, billing) →
            </Link>
            <Link href="/operator" className="text-primary hover:underline">Operator console</Link>
          </div>
        </div>

        <TenantFilterBar
          q={q}
          plan={plan}
          billing={billing}
          page={tenantPage?.page ?? pageNum}
          pageSize={tenantPage?.pageSize ?? 10}
          total={tenantPage?.total ?? tenantList.length}
          basePath="/operator/tenants"
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
                  {canSetStatus && <SchoolStatusToggle schoolId={t.id} status={t.status} />}
                </div>
                {canManageSubscription && <SubscriptionManager schoolId={t.id} plan={t.plan} />}
                {canManageGrace && <GraceEditor schoolId={t.id} initial={t.graceDays} />}
                {canReadUsers && (
                  <OperatorUsers schoolId={t.id} schoolName={t.name} canCredentials={canCredentials} canImpersonate={canImpersonate} />
                )}
                {canReadStudents && <OperatorStudents schoolId={t.id} />}
                {canReadStudents && <StudentDataExport schoolId={t.id} schoolName={t.name} />}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
