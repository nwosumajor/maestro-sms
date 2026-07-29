import type { PendingApprovalDto, Serialized } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { WorkflowInbox, type WorkflowDto } from "@/components/workflow/WorkflowInbox";
import { OtherApprovals } from "@/components/workflow/OtherApprovals";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const session = await auth();
  const user = session!.user;
  // Two independent reads: the workflow engine's own inbox, and the aggregated
  // pending decisions that live in OTHER modules. The aggregate needs no
  // permission of its own — it only ever returns sources the caller can already
  // act on — so an approver WITHOUT workflow.read (e.g. an accountant holding
  // only fee.approve) still gets a useful page.
  const [requests, others] = await Promise.all([
    apiGet<WorkflowDto[]>("/workflows"),
    apiGet<Serialized<PendingApprovalDto>[]>("/approvals/pending"),
  ]);
  const other = others ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="workflows" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Approvals</>} subtitle={<>Everything waiting on you, in one place. Requests move through a
            deterministic state machine; every transition is written to an
            immutable, append-only audit trail, and you cannot review a request
            you initiated (separation of duties).</>} />

        <OtherApprovals items={other} />

        {requests === null ? (
          other.length === 0 ? (
            <Alert variant="info">
              <AlertTitle>Nothing waiting on you</AlertTitle>
              <AlertDescription>
                You have no pending approvals right now. (Approval requests themselves also need{" "}
                <code>workflow.read</code>, which your role does not include.)
              </AlertDescription>
            </Alert>
          ) : null
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
