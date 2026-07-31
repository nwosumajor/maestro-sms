import type { GroupOverviewDto, Serialized } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { GroupBoard } from "@/components/group/GroupBoard";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

// Cross-campus dashboard for multi-school proprietors (the GROUP add-on).
// Directorship is verified server-side (404 for everyone else) — this page
// simply renders whatever the API allows. Aggregates only, never student PII.
export default async function GroupPage({
  searchParams,
}: {
  searchParams: { groupId?: string; period?: string };
}) {
  const session = await auth();
  const user = session!.user;
  const q = new URLSearchParams();
  if (searchParams.groupId) q.set("groupId", searchParams.groupId);
  if (searchParams.period) q.set("period", searchParams.period);
  const data = await apiGet<Serialized<GroupOverviewDto>>(
    `/group/overview${q.toString() ? `?${q.toString()}` : ""}`,
  );

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="group" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader
          title={<>{data ? data.groupName : "Group console"}</>}
          subtitle={
            <>
              One view across every campus — enrolment, attendance, collections and each school&apos;s
              subscription health. Figures only: a director sees how a campus is doing, never who is in
              it.
            </>
          }
        />

        {!data ? (
          <Alert variant="info">
            <AlertTitle>No group access</AlertTitle>
            <AlertDescription>
              This console is for designated group directors. If you run several schools on the platform,
              ask the platform operator to set up your group and name you as a director.
            </AlertDescription>
          </Alert>
        ) : (
          <GroupBoard data={data} />
        )}
      </div>
    </AppShell>
  );
}
