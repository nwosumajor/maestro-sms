// Needs a decision — the platform owner's triage list. Moved off the /operator hub
// to its own page, reachable from the sidebar.
//
// Two reasons it belongs here rather than on the hub:
//   • COST. The queue is the most expensive read in the console: it examines every
//     active school, and at the 5,000-school target that is seconds of work. On the
//     hub it ran on every visit, including the many that were about pricing, promos
//     or provisioning. Now it runs when somebody is actually triaging.
//   • USE. Triage is a task with its own session — you work down the list. It was
//     competing for attention with eight other cards.
//
// Fetched SERVER-side rather than by a client island, so the rows arrive with the
// page instead of after it. Filtering stays client-side over rows already in hand:
// re-running the whole fleet scan just to hide some rows would be the expensive
// half of a round trip for a purely visual change.

import type { AttentionQueueDto, Serialized } from "@sms/types";
import Link from "next/link";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { AttentionQueue } from "@/components/operator/AttentionQueue";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function OperatorAttentionPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "platform.tenants.read")) redirect("/dashboard");

  const queue = await apiGet<Serialized<AttentionQueueDto>>("/operator/attention");

  return (
    <AppShell
      schoolName={user.schoolName}
      userName={user.name ?? "User"}
      active="operatorattention"
      permissions={user.permissions}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            title={<>Needs a decision</>}
            subtitle={
              <>
                Every active school checked against six conditions — overdue payment, trial ending,
                growth outrunning billed seats, no recorded use, registers stopped, and no
                administrator. Ranked by how late it already is, then by what is at stake.
                Counts and money only; no pupil or staff member is named.
              </>
            }
          />
          <Link href="/operator" className={buttonVariants({ variant: "outline", size: "sm" })}>
            ← Operator console
          </Link>
        </div>

        {queue === null ? (
          <Alert variant="info">
            <AlertTitle>Not available</AlertTitle>
            <AlertDescription>
              The attention queue needs the privileged database configuration, which reads across
              tenants. It is disabled rather than partial — a queue missing half the fleet would be
              read as an all-clear.
            </AlertDescription>
          </Alert>
        ) : (
          <AttentionQueue queue={queue} />
        )}
      </div>
    </AppShell>
  );
}
