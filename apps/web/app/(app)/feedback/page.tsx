import type { MyFeedbackDto, Serialized } from "@sms/types";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { FeedbackClient } from "@/components/feedback/FeedbackClient";

export const dynamic = "force-dynamic";

// Platform feedback is open to EVERY signed-in role — no permission gate. Any
// user can send the platform owner a complaint or a feature suggestion, and see
// the status of their own submissions.
export default async function FeedbackPage() {
  const session = await auth();
  const user = session!.user;
  // A REVIEWER is the recipient of this channel, not a sender — sending feedback
  // to yourself is meaningless. Send them to the inbox, where they reply inside
  // each thread. (platform.feedback.review is a platform permission held only by
  // super_admin / manager_admin, so no school user is affected.)
  if (hasPermission(user.permissions, "platform.feedback.review")) redirect("/operator/feedback");

  const mine = await apiGet<Serialized<MyFeedbackDto>[]>("/feedback/mine");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="feedback" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader
          title={<>Send feedback</>}
          subtitle={<>Report a problem or suggest a new feature to the platform team. We read every message.</>}
        />
        <FeedbackClient mine={mine ?? []} />
      </div>
    </AppShell>
  );
}
