import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ErasureReview, type ErasureRequest } from "@/components/privacy/ErasureReview";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function AdminPrivacyPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "privacy.erasure.review")) redirect("/dashboard");
  const requests = (await apiGet<ErasureRequest[]>("/privacy/erasure")) ?? [];
  // What the retention sweeps actually deleted. /integrity/retention/runs was
  // built and rendered nowhere, so "what happened to last year's telemetry?" —
  // the first question a data-protection officer asks — had no answer in-product.
  const runs =
    (await apiGet<
      { id: string; retentionDays: number; cutoff: string; signalsDeleted: number; draftsDeleted: number; telemetryDeleted: number; xapiDeleted: number; scansDeleted: number; trigger: string; createdAt: string }[]
    >("/integrity/retention/runs")) ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={<>Erasure requests</>} subtitle={<>Right-to-erasure requests to review against retention obligations.</>} />

        {/* Evidence that the retention policy is actually enforced, not just
            configured. Counts only — never what was purged. */}
        <section className="rounded-lg border border-border bg-card p-4">
          <header className="mb-1 flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Retention history</h2>
            <span className="text-xs text-muted-foreground">what was deleted, and when</span>
          </header>
          <p className="mb-3 text-xs text-muted-foreground">
            Telemetry about pupils is deleted on your school&rsquo;s retention window. These are the runs that did it.
          </p>
          {runs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No purge has run yet — either the window has not elapsed, or retention is disabled for this school.
            </p>
          ) : (
            <ul className="divide-y divide-border/70">
              {runs.slice(0, 12).map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                  <span>
                    {new Date(r.createdAt).toLocaleDateString()}
                    <span className="ml-1 text-xs text-muted-foreground">
                      {r.trigger.toLowerCase()} · kept {r.retentionDays} days
                    </span>
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {r.signalsDeleted + r.draftsDeleted + r.telemetryDeleted + r.xapiDeleted + r.scansDeleted} records removed
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>
        {requests.length === 0 ? (
          <Alert variant="info"><AlertTitle>No requests</AlertTitle><AlertDescription>No erasure requests are pending.</AlertDescription></Alert>
        ) : (
          <ErasureReview requests={requests} />
        )}
      </div>
    </AppShell>
  );
}
