import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { WorkflowInbox, type WorkflowDto } from "@/components/workflow/WorkflowInbox";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const session = await auth();
  const user = session!.user;
  const requests = await apiGet<WorkflowDto[]>("/workflows");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="workflows" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Approvals</>} subtitle={<>Requests move through a deterministic state machine. Every transition
            is written to an immutable, append-only audit trail; you cannot review
            a request you initiated (separation of duties).</>} />

        {requests === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>
              Your role does not include <code>workflow.read</code>, or the session
              expired.
            </AlertDescription>
          </Alert>
        ) : (
          <WorkflowInbox
            initial={requests}
            userId={user.id}
            permissions={user.permissions}
          />
        )}
      </div>
    </AppShell>
  );
}
