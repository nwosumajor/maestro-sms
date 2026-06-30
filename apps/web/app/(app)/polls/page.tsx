import type { PollDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { PollBoard } from "@/components/poll/PollBoard";

export const dynamic = "force-dynamic";

export default async function PollsPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "poll.vote")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "poll.manage");
  const polls = (await apiGet<Serialized<PollDto>[]>("/polls")) ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="polls" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Polls</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {canManage
              ? "Collect anonymous opinions from students and staff to inform decisions."
              : "Cast your anonymous vote. Your choice is never linked to your identity."}
          </p>
        </div>
        <PollBoard polls={polls} canManage={canManage} />
      </div>
    </AppShell>
  );
}
