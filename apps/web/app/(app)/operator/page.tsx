import type {
  OnboardingRequestDto,
  OperatorAdminAppointmentDto,
  OperatorBillingAlertDto,
  Serialized,
  TenantNameDto,
} from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Provisioning } from "@/components/operator/Provisioning";
import { OnboardingRequests } from "@/components/operator/OnboardingRequests";
import { GroupsManager } from "@/components/operator/GroupsManager";
import { PlatformStaff } from "@/components/operator/PlatformStaff";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function OperatorPage({
  searchParams,
}: {
  searchParams: { provision?: string };
}) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "platform.tenants.read")) redirect("/dashboard");
  // Platform duties are delegable (manager_admin) but ownership is not. Show each
  // control only when the caller holds the permission its API actually requires —
  // the API enforces this regardless (403), this just avoids dead buttons.
  const canProvision = hasPermission(user.permissions, "platform.tenants.write");
  const canManageSubscription = hasPermission(user.permissions, "platform.subscription.manage");
  const canManagePricing = hasPermission(user.permissions, "platform.pricing.manage");
  const canReviewOnboarding = hasPermission(user.permissions, "platform.onboarding.review");
  // Hiring platform staff is the one duty that can never be delegated: staff
  // creating staff would let a manager mint another manager.
  const canManageStaff = hasPermission(user.permissions, "platform.staff.manage");
  const canAdminScholarships = hasPermission(user.permissions, "scholarship.admin");

  // Plan pricing, the fee take rate and growth (promos/agents/commissions) moved to
  // /operator/pricing: five API calls and three heavy editors that this page paid
  // for on every visit, for controls revisited monthly at most.
  const [names, onboarding, billingAlerts, adminAppointments] = await Promise.all([
    apiGet<TenantNameDto[]>("/operator/tenant-names"),
    apiGet<Serialized<OnboardingRequestDto>[]>("/operator/onboarding-requests"),
    apiGet<Serialized<OperatorBillingAlertDto>[]>("/operator/billing-alerts"),
    apiGet<Serialized<OperatorAdminAppointmentDto>[]>("/operator/admin-appointments"),
  ]);
  const groups = canManageSubscription ? await apiGet<never[]>("/operator/groups").then((r) => r ?? []) : [];

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
          <PageHeader title={<>Operator console</>} subtitle={<>Provision schools and review onboarding. Triage in Needs a decision, manage each school in the
              Tenant registry, set what the platform charges in Pricing &amp; growth, and handle message credits
              and platform-sponsored scholarships on their own pages.</>} />
          <Link href="/dashboard"><Button variant="outline">Platform analytics →</Button></Link>
        </div>

        {/* Quick links to the pages the registry + scholarship management moved to. */}
        <div className="flex flex-wrap gap-2">
          {/* First, deliberately: triage before administration. The queue lives on
              its own page because it scans every active school, and running that on
              every visit to this hub was work nobody had asked for. */}
          <Link href="/operator/attention"><Button size="sm">Needs a decision →</Button></Link>
          <Link href="/operator/tenants"><Button variant="outline" size="sm">Tenant registry →</Button></Link>
          {canManagePricing && (
            <Link href="/operator/pricing"><Button variant="outline" size="sm">Pricing &amp; growth →</Button></Link>
          )}
          <Link href="/operator/schools"><Button variant="outline" size="sm">School directory →</Button></Link>
          <Link href="/operator/message-credits"><Button variant="outline" size="sm">Message credits →</Button></Link>
          {canAdminScholarships && (
            <Link href="/operator/scholarships"><Button variant="outline" size="sm">Scholarship admin →</Button></Link>
          )}
        </div>

        {/* RED ALERT: every school past its paid period, most overdue first. The
            controls live on each tenant card in the Tenant registry (restore/
            extend/comp via the subscription editor) — this banner makes sure
            none sits unnoticed. */}
        {(billingAlerts?.length ?? 0) > 0 && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm font-semibold text-destructive">
              ⚠ {billingAlerts!.length} school{billingAlerts!.length === 1 ? "" : "s"} past their subscription period
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {billingAlerts!.map((a) => (
                <li key={a.schoolId} className="flex flex-wrap items-center gap-2">
                  <Link href={`/operator/tenants?billing=PAST_DUE&q=${encodeURIComponent(a.name)}`} className="font-medium hover:underline">
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
              Open the school in the{" "}
              <Link href="/operator/tenants?billing=PAST_DUE" className="underline">Tenant registry</Link>{" "}
              to extend the period, comp, or restore — paying restores the plan automatically.
            </p>
          </div>
        )}

        {/* Cross-tenant oversight of the junior-admin maker-checker: who is
            being appointed into each school's admin tier and whether the
            school's SECOND senior has decided. Read-only — the decision stays
            inside the school (separation of duties); the operator observes. */}
        <div className="rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">Admin appointments</p>
            {(adminAppointments?.length ?? 0) > 0 && (
              <Badge variant="outline">
                {adminAppointments!.filter((a) => a.state === "PENDING_REVIEW").length} awaiting a second senior
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Junior-admin tier grants across every school — each is maker-checker: raised by one senior, applied only
            after a different senior approves. The decision belongs to the school; this list is oversight.
          </p>
          {(adminAppointments?.length ?? 0) === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No admin appointments yet.</p>
          ) : (
            <ul className="mt-3 space-y-1.5 text-sm">
              {adminAppointments!.map((a) => (
                <li key={a.requestId} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{a.schoolName}</span>
                  <span className="text-muted-foreground">
                    {a.initiatorName ?? "(unknown)"} → {a.targetUserName ?? "(unknown)"}
                    {a.targetUserEmail ? ` (${a.targetUserEmail})` : ""} as
                  </span>
                  <Badge variant="secondary">{a.roleName}</Badge>
                  {a.state === "PENDING_REVIEW" ? (
                    <Badge variant="outline">awaiting approval</Badge>
                  ) : a.state === "APPROVED" ? (
                    <Badge variant="secondary">approved</Badge>
                  ) : (
                    <Badge variant="destructive">{a.state.toLowerCase().replace(/_/g, " ")}</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">{dateTime(a.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Keyed on the request id so entering/leaving prefill re-initialises the form. */}
        {canProvision && <Provisioning key={prefill?.requestId ?? "blank"} tenants={names ?? []} prefill={prefill} />}

        {canManageSubscription && (
          <GroupsManager groups={groups} schools={(names ?? []).map((n) => ({ id: n.id, name: n.name }))} />
        )}

        {canReviewOnboarding && <OnboardingRequests requests={onboarding ?? []} />}
        {canManageStaff && <PlatformStaff />}
      </div>
    </AppShell>
  );
}
