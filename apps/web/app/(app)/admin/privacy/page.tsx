import { MODULES } from "@sms/types";
import { regionOf, shortDate } from "@/lib/format";
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
  // Dates follow the SCHOOL's timezone, not the platform's.
  const region = regionOf(user);
  if (!hasPermission(user.permissions, "privacy.erasure.review")) redirect("/dashboard");
  // NULL IS NOT EMPTY, and on this page that distinction is the whole point.
  // apiGet returns null when it could not ask (403, or a 404 because the
  // school's plan does not include the module) and [] only when the answer is
  // genuinely "none". Both were collapsed with `?? []`, so a page whose job is
  // to be EVIDENCE asserted facts it had not established.
  const requests = await apiGet<ErasureRequest[]>("/privacy/erasure");
  // What the retention sweeps actually deleted. Gated before asking: the runs
  // endpoint needs integrity.retention.run AND the INTEGRITY module, which the
  // STANDARD plan does not include — so on a STANDARD school this 404s, and
  // saying "no purge has run" there is a guess dressed as a record.
  const canReadRuns = hasPermission(user.permissions, "integrity.retention.run");
  // INTEGRITY is a PREMIUM add and this page is an always-on privacy
  // obligation, so on a plan without it `/integrity/retention/runs` answers 404
  // and `apiGet` returns null exactly as for a real failure. The copy below was
  // careful enough to mention the possibility, but it still asked the READER to
  // work out which had happened, in red. The page knows; it should say.
  const hasIntegrity = !user.modules || user.modules.includes(MODULES.INTEGRITY);
  const runs = canReadRuns && hasIntegrity
    ? await apiGet<
        { id: string; retentionDays: number; cutoff: string; signalsDeleted: number; draftsDeleted: number; telemetryDeleted: number; xapiDeleted: number; scansDeleted: number; trigger: string; createdAt: string }[]
      >("/integrity/retention/runs")
    : null;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={<>Erasure requests</>} subtitle={<>Right-to-erasure requests to review against retention obligations.</>} />
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>

        {/* Evidence that the retention policy is actually enforced, not just
            configured. Counts only — never what was purged.
            This section used to sit INSIDE the header's flex row, between the
            title and the back link, so the card rendered squashed into the
            header bar with "← Admin" beside it rather than at the far right. */}
        <section className="rounded-lg border border-border bg-card p-4">
          <header className="mb-1 flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Retention history</h2>
            <span className="text-xs text-muted-foreground">what was deleted, and when</span>
          </header>
          <p className="mb-3 text-xs text-muted-foreground">
            Telemetry about pupils is deleted on your school&rsquo;s retention window. These are the runs that did it.
          </p>
          {!canReadRuns ? (
            <p className="text-xs text-muted-foreground">
              Your role cannot read the retention history — ask a principal or school administrator.
            </p>
          ) : !hasIntegrity ? (
            <p className="text-xs text-muted-foreground">
              Your plan does not include Assessment Integrity, so no behavioural telemetry about pupils is collected
              and there is nothing to purge.
            </p>
          ) : runs === null ? (
            <p className="text-xs text-destructive">
              The retention history could not be loaded, so this is <strong>not</strong> a record that nothing was
              deleted. Retry, and report it if it persists.
            </p>
          ) : runs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No purge has run yet — either the window has not elapsed, or retention is disabled for this school.
            </p>
          ) : (
            <ul className="divide-y divide-border/70">
              {runs.slice(0, 12).map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                  <span>
                    {shortDate(r.createdAt, region)}
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

        {requests === null ? (
          <Alert variant="destructive">
            <AlertTitle>Requests could not be loaded</AlertTitle>
            <AlertDescription>
              This is not a report that none are pending. A right-to-erasure request has a statutory clock, so
              retry rather than treating this as an empty queue.
            </AlertDescription>
          </Alert>
        ) : requests.length === 0 ? (
          <Alert variant="info"><AlertTitle>No requests</AlertTitle><AlertDescription>No erasure requests are pending.</AlertDescription></Alert>
        ) : (
          <ErasureReview requests={requests} />
        )}
      </div>
    </AppShell>
  );
}
