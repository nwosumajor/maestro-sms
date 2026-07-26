import type { FeedbackStatsDto, PageDto, PlatformFeedbackDto, Serialized } from "@sms/types";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { FeedbackInbox } from "@/components/feedback/FeedbackInbox";

export const dynamic = "force-dynamic";

// The platform owner's cross-tenant feedback inbox. Gated on the DELEGABLE
// platform.feedback.review permission (super_admin + manager_admin). The API
// reads across tenants via the privileged client; the page shows the FIRST page
// and the client island seek-paginates + reviews from there.
export default async function OperatorFeedbackPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "platform.feedback.review")) redirect("/dashboard");

  const [first, stats] = await Promise.all([
    apiGet<Serialized<PageDto<PlatformFeedbackDto>>>("/operator/feedback?limit=25"),
    apiGet<Serialized<FeedbackStatsDto>>("/operator/feedback/stats"),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="operatorfeedback" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader
          title={<>Feedback inbox</>}
          subtitle={<>Complaints and feature suggestions from users across every school.</>}
        />
        <FeedbackInbox initial={first ?? { items: [], nextCursor: null }} stats={stats ?? null} />
      </div>
    </AppShell>
  );
}
