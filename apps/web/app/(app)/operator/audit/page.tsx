import type { TenantNameDto, PlatformAuditPageDto, Serialized } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PlatformAudit } from "@/components/operator/PlatformAudit";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function OperatorAuditPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "platform.audit.read")) redirect("/dashboard");
  // Lightweight id+name list for the filter dropdown. NOTE: /operator/tenants
  // returns a PAGINATED object ({ tenants, total, … }), not an array — use the
  // dedicated picker endpoint so this never regresses to `.map is not a function`.
  const [tenants, page] = await Promise.all([
    apiGet<Serialized<TenantNameDto>[]>("/operator/tenant-names"),
    apiGet<Serialized<PlatformAuditPageDto>>("/operator/audit?limit=50"),
  ]);
  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="operatoraudit" permissions={user.permissions}>
      <div className="space-y-6">
        {/* An empty platform audit log is a claim: "nothing happened across any
            school". A failed read must not be able to make it. */}
        {page === null && (
          <Alert variant="destructive">
            <AlertTitle>The audit log could not be loaded</AlertTitle>
            <AlertDescription>
              No entries are shown because the read failed — not because nothing has happened across the fleet.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <PageHeader title={<>Platform audit</>} subtitle={<>Track and investigate every change and approval across all customer schools — including those made by
              each school&apos;s principal and admins — with full actor attribution.</>} />
          <Link href="/operator"><Button variant="outline">Operator console →</Button></Link>
        </div>
        <PlatformAudit
          tenants={(tenants ?? []).map((t) => ({ id: t.id, name: t.name }))}
          initial={page?.entries ?? []}
          initialCursor={page?.nextCursor ?? null}
        />
      </div>
    </AppShell>
  );
}
