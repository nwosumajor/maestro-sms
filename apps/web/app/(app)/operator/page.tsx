import type {
  OnboardingRequestDto,
  OperatorAdminAppointmentDto,
  OperatorBillingAlertDto,
  Serialized,
  TenantNameDto, MisplacedPlatformRoleDto } from "@sms/types";
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
import { PlatformRoleAudit } from "@/components/operator/PlatformRoleAudit";
import { OnboardingRequests } from "@/components/operator/OnboardingRequests";
import { PlatformStaff } from "@/components/operator/PlatformStaff";
import { PlatformDelegations } from "@/components/operator/PlatformDelegations";
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
  const [names, onboarding, billingAlerts, adminAppointments, roleAudit, platformStaff] = await Promise.all([
    apiGet<TenantNameDto[]>("/operator/tenant-names"),
    apiGet<Serialized<OnboardingRequestDto>[]>("/operator/onboarding-requests"),
    apiGet<Serialized<OperatorBillingAlertDto>[]>("/operator/billing-alerts"),
    apiGet<Serialized<OperatorAdminAppointmentDto>[]>("/operator/admin-appointments"),
    // A security finding report that had no screen at all. Empty is the expected
    // state, and the panel renders nothing when it is.
    apiGet<Serialized<MisplacedPlatformRoleDto>[]>("/operator/platform-role-audit"),
    // Owner-only, and only to fill the delegate picker — a manager_admin never
    // fetches it, so this costs nothing on the delegated path.
    canManageStaff
      ? apiGet<{ id: string; name: string; email: string }[]>("/operator/platform-staff")
      : Promise.resolve(null),
  ]);

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
          {canManageSubscription && (
            <Link href="/operator/groups"><Button variant="outline" size="sm">School groups →</Button></Link>
          )}
          <Link href="/operator/schools"><Button variant="outline" size="sm">School directory →</Button></Link>
          <Link href="/operator/payments"><Button variant="outline" size="sm">Subscription revenue →</Button></Link>
          <Link href="/operator/message-credits"><Button variant="outline" size="sm">Message credits →</Button></Link>
          {canAdminScholarships && (
            <Link href="/operator/scholarships"><Button variant="outline" size="sm">Scholarship admin →</Button></Link>
          )}
        </div>

        {/* THE RUNBOOKS, one click from the console.
            They were markdown in the repository, which is the right place to
            MAINTAIN them and the wrong place to READ them: the moment they are
            needed it is the middle of the night and whoever is on call may not
            have a checkout to hand. Rendered from the same files, so there is no
            second copy to go stale — the discipline of updating the runbook in
            the same PR as the behaviour it describes still points at the .md. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Runbooks:</span>
          <a href="/runbooks/incident" target="_blank" rel="noopener noreferrer">
            <Button variant="outline" size="sm">Incident response ↗</Button>
          </a>
          <a href="/runbooks/backup" target="_blank" rel="noopener noreferrer">
            <Button variant="outline" size="sm">Backup &amp; restore ↗</Button>
          </a>
          <span className="text-xs text-muted-foreground">Read them before you need them.</span>
        </div>

        {/* The alarm stays on the page opened daily — but as ONE line, not a
            restatement of the queue. It costs a single indexed query (past-due
            subscriptions), never the fleet scan, and the DETAIL now lives in one
            place: the queue says whether each school is still in its grace window
            or already downgraded. Two places showing the same fact is how they
            drift apart. Scope matches the queue exactly (active schools only), so
            this count can never exceed the list it links to. */}
        {/* A SILENT ALARM IS WORSE THAN NO ALARM. `?? 0` hid this banner
            entirely when the read failed, so the page an owner opens daily to
            catch lapsed schools looked exactly like a day with none. */}
        {billingAlerts === null && (
          <p className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            ⚠ Past-due schools could not be checked — this is <strong>not</strong> a report that none are.
          </p>
        )}

        {(billingAlerts?.length ?? 0) > 0 && (
          <Link
            href="/operator/attention?kind=PAST_DUE"
            className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm hover:bg-destructive/15"
          >
            <span className="font-semibold text-destructive">
              ⚠ {billingAlerts!.length} school{billingAlerts!.length === 1 ? "" : "s"} past their subscription period
            </span>
            <span className="text-muted-foreground">— review in Needs a decision →</span>
          </Link>
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
          {adminAppointments === null ? (
            <p className="mt-3 text-sm text-destructive">
              This list could not be loaded. Appointments awaiting a second senior are <strong>not</strong>
              {" "}shown as none — they are simply unknown right now.
            </p>
          ) : adminAppointments.length === 0 ? (
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

        {/* Above the routine work: a platform role inside a customer school is a
            security finding, not a queue item. Renders nothing when clean. */}
        {/* This panel renders NOTHING when empty, by design — so a failed read
            was indistinguishable from a clean bill of health on a security
            finding report. Say so instead. */}
        {roleAudit === null ? (
          <p className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            The platform-role audit could not be run — this is not a finding of &ldquo;no misplaced platform
            roles&rdquo;.
          </p>
        ) : (
          <PlatformRoleAudit initial={roleAudit} />
        )}
        {canReviewOnboarding && onboarding === null && (
          <p className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            Onboarding requests could not be loaded — schools waiting to be provisioned would not appear.
          </p>
        )}
        {canReviewOnboarding && onboarding !== null && <OnboardingRequests requests={onboarding} />}
        {canManageStaff && <PlatformStaff />}
        {/* Beside hiring, because it is the same job: who works here, and what may
            they do this month. */}
        {canManageStaff && <PlatformDelegations staff={platformStaff ?? []} />}
      </div>
    </AppShell>
  );
}
