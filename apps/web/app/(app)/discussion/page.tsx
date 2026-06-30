import type { DiscussionGroupDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { DiscussionHub } from "@/components/discussion/DiscussionHub";

export const dynamic = "force-dynamic";

export default async function DiscussionPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "discussion.participate")) redirect("/dashboard");
  const canModerate = hasPermission(user.permissions, "discussion.moderate");
  const groups = (await apiGet<Serialized<DiscussionGroupDto>[]>("/discussion/groups")) ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="discussion" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Discussion Hub</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Topic groups where students and teachers exchange ideas. {canModerate ? "You can create groups and remove unwanted posts." : "Post and comment within your groups."}
          </p>
        </div>
        <DiscussionHub groups={groups} canModerate={canModerate} />
      </div>
    </AppShell>
  );
}
