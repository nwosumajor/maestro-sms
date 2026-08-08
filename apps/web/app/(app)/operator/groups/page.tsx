// School groups — multi-campus registries, the operator's own page.
//
// Moved off the /operator hub for one reason above the others: it is gated by a
// DIFFERENT permission from everything around it. `platform.subscription.manage`
// governs groups; the hub's other sections need tenants.write, onboarding.review,
// pricing.manage or staff.manage. A page whose sections each answer to a different
// permission renders half-empty for half its viewers, with nothing on screen to say
// why — which reads as broken rather than as restricted.
//
// It is also rare work. A group is created when a proprietor brings a second campus
// onto the platform, which is not a daily event, and it was costing the hub a fetch
// on every visit.

import type { TenantNameDto } from "@sms/types";
import Link from "next/link";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { GroupsManager } from "@/components/operator/GroupsManager";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function OperatorGroupsPage() {
  const session = await auth();
  const user = session!.user;
  // Redirect, not just a hidden nav item: hiding a link is presentation, and
  // someone who types the URL should land somewhere useful rather than on controls
  // the API will refuse.
  if (!hasPermission(user.permissions, "platform.subscription.manage")) redirect("/operator");

  const [groups, names] = await Promise.all([
    apiGet<never[]>("/operator/groups"),
    apiGet<TenantNameDto[]>("/operator/tenant-names"),
  ]);

  return (
    <AppShell
      schoolName={user.schoolName}
      userName={user.name ?? "User"}
      active="operatorgroups"
      permissions={user.permissions}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            title={<>School groups</>}
            subtitle={
              <>
                Multi-campus registries: which schools belong to a group, and who directs it.
                Directorship is the authorisation — a director sees cross-campus totals on their own
                /group console, never another campus&apos;s pupil records. Managed here because the
                group registry is platform-owned; schools cannot add themselves to one.
              </>
            }
          />
          <Link href="/operator" className={buttonVariants({ variant: "outline", size: "sm" })}>
            ← Operator console
          </Link>
        </div>

        {groups === null && (
          <Alert variant="destructive">
            <AlertTitle>Groups could not be loaded</AlertTitle>
            <AlertDescription>
              This is not a report that no school group exists. Creating one from here could duplicate a group
              you cannot currently see.
            </AlertDescription>
          </Alert>
        )}
        <GroupsManager groups={groups ?? []} schools={(names ?? []).map((n) => ({ id: n.id, name: n.name }))} />
      </div>
    </AppShell>
  );
}
