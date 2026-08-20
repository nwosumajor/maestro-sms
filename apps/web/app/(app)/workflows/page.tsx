import type { PendingApprovalDto, Serialized, WorkflowPageDto } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { regionOf } from "@/lib/format";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { WorkflowInbox, type WorkflowDto } from "@/components/workflow/WorkflowInbox";
import { OtherApprovals } from "@/components/workflow/OtherApprovals";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

/** Only the filters that were actually set — an empty query string keeps the
 *  endpoint's default, which is what it always returned. */
function qs(sp: { type?: string; state?: string; q?: string; page?: string; mine?: string }) {
  const params = new URLSearchParams();
  for (const key of ["type", "state", "q", "page", "mine"] as const) {
    const v = sp[key];
    if (v) params.set(key, v);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export default async function WorkflowsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; state?: string; q?: string; page?: string; mine?: string }>;
}) {
  const sp = await searchParams;
  const session = await auth();
  const user = session!.user;
  // Two independent reads: the workflow engine's own inbox, and the aggregated
  // pending decisions that live in OTHER modules. The aggregate needs no
  // permission of its own — it only ever returns sources the caller can already
  // act on — so an approver WITHOUT workflow.read (e.g. an accountant holding
  // only fee.approve) still gets a useful page.
  // GET /workflows requires workflow.read; six roles legitimately lack it
  // (student, parent, warden, driver, manager_admin, super_admin). The call is
  // gated so that ABSENCE is expressed here, in the page, rather than left for
  // the API to refuse — an unguarded call 403s, and apiGet now treats a 403 as
  // the web and API disagreeing and throws, which turned this page into an
  // error screen for those roles.
  const canReadWorkflows = hasPermission(user.permissions, "workflow.read");
  const [requests, others] = await Promise.all([
    // The register is filtered and paged in the DATABASE. It used to return the
    // 500 most recent, unfiltered — measured at 702 requests, the oldest one a
    // school could reach was three weeks old and nothing could show what came
    // before it.
    canReadWorkflows
      ? apiGet<Serialized<WorkflowPageDto>>(`/workflows${qs(sp)}`)
      : Promise.resolve(null),
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

        <OtherApprovals items={other} region={regionOf(user)} />

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
            initial={requests.items}
            total={requests.total}
            page={requests.page}
            pageSize={requests.pageSize}
            filters={{ type: sp.type ?? "", state: sp.state ?? "", q: sp.q ?? "", mine: sp.mine === "1" }}
            userId={user.id}
            permissions={user.permissions}
          />
        )}
      </div>
    </AppShell>
  );
}
