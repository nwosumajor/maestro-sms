// The background jobs console.
//
// Thirteen jobs run on timers, and every one that moves money is among them:
// dunning, payment reconciliation, mobile-money recovery, late fees. Nothing
// recorded that any of them had run — the only trace was a log line needing
// shell access to read and gone on rotation.
//
// A scheduler that stops does not error. It goes quiet: dunning stops charging,
// reconciliation stops recovering lost payments, the overdue-boarder check stops
// looking, and the first sign is a complaint months later. From outside, "swept
// and found nothing" and "has not swept since March" are the same silence.
//
// This page is the difference between those two.

import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/PageHeader";
import { JobsTable, type JobStatus } from "@/components/operator/JobsTable";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "platform.tenants.read")) redirect("/dashboard");

  const jobs = await apiGet<JobStatus[]>("/operator/jobs");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="operator" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader
          title="Background jobs"
          subtitle={<>What runs on a timer, when it last ran, and what it did.</>}
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Scheduled jobs</CardTitle>
          </CardHeader>
          <CardContent>
            {/* `null` from apiGet means the read FAILED, which is not the same
                fact as "no jobs" — and on this page of all pages, an empty
                table would read as "nothing is running". */}
            {jobs === null ? (
              <p className="text-sm text-destructive">
                We couldn&apos;t load the job history. That is a problem with this page, not
                necessarily with the jobs — please refresh.
              </p>
            ) : (
              <JobsTable jobs={jobs} />
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
