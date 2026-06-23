import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { WorkflowInbox, type WorkflowDto } from "@/components/workflow/WorkflowInbox";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const session = await auth();
  const user = session!.user;
  const requests = await apiGet<WorkflowDto[]>("/workflows");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="workflows" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Requests move through a deterministic state machine. Every transition
            is written to an immutable, append-only audit trail; you cannot review
            a request you initiated (separation of duties).
          </p>
        </div>

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
