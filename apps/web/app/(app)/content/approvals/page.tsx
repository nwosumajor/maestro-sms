import type { LmsContentDto, Serialized } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApprovalQueue } from "@/components/lms/ApprovalQueue";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

// The principal's LMS content approval queue (school-wide, PENDING_APPROVAL).
// Gated by lms.content.approve at the API; separation of duties is enforced by
// the workflow engine — the approver can never be the author.
export default async function ContentApprovalsPage() {
  const session = await auth();
  const user = session!.user;

  const pending = await apiGet<Serialized<LmsContentDto>[]>("/content/approvals/pending");

  return (
    <AppShell
      schoolName={user.schoolName}
      userName={user.name ?? "User"}
      active="classes"
      permissions={user.permissions}
    >
      <div className="space-y-6">
        <PageHeader title={<>Content approvals</>} subtitle={<>Learning content awaiting your review. Approving publishes it to
            enrolled students; you can also request a revision or reject it.</>} />

        {pending === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>
              Your role does not include <code>lms.content.approve</code>.
            </AlertDescription>
          </Alert>
        ) : (
          <ApprovalQueue initial={pending} />
        )}
      </div>
    </AppShell>
  );
}
