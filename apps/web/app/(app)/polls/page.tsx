import type { PollDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { PollBoard } from "@/components/poll/PollBoard";
import { PageHeader } from "@/components/shell/PageHeader";

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
        <PageHeader title={<>Polls</>} subtitle={<>{canManage
              ? "Collect anonymous opinions from students and staff to inform decisions."
              : "Cast your anonymous vote. Your choice is never linked to your identity."}</>} />
        <PollBoard polls={polls} canManage={canManage} />
      </div>
    </AppShell>
  );
}
